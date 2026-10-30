#!/usr/bin/env bun
import { buildBudget, buildExplain, formatBudget, formatExplain } from "./budget.ts";
import { formatQuotaReport } from "./collectors/claude-quota.ts";
import { collectors } from "./collectors/index.ts";
import { DEFAULT_IU_KEY, IU_KEYS, iuKeyDef } from "./iu-keys.ts";
import { collectPortal, iuPortalFreshnessAll } from "./collectors/iu-portal.ts";
import { formatRunSummary, runIngest } from "./ingest.ts";
import {
  formatBillingAudit,
  formatSources,
  formatStale,
  formatStats,
  GROUP_BY_DIMS,
  sessionBillingAudit,
  sourceStatus,
  staleSources,
  stats,
  unpricedByModel,
  type GroupBy,
} from "./report.ts";
import { connect } from "./pg/connect.ts";
import { runPgCommand } from "./pg/cli.ts";
import { formatReprice, reprice } from "./reprice.ts";
import { loadChanges } from "./changes.ts";
import { formatWeekly, parseIsoWeek, weeklyReport, writeWeekly } from "./weekly.ts";
import { formatWindow, WINDOW_BY_DIMS, windowShare, type WindowBy } from "./window.ts";

const HELP = `usage-tracker — local token/cost telemetry across AI tools

USAGE
  usage-tracker <command> [options]

COMMANDS
  ingest                 Run all available collectors incrementally (default)
    --full               Ignore watermarks and re-scan everything
    --source <name>      Only run one collector (claude-code|codex|hermes|feuer|opencode|litellm|modelpick|astra|athena-teamchat|email-gateway)
  reprice                Re-cost stored rows against the current prices (usage.compute_cost); provider-reported rows are never touched
    --model <name>       Only this records.model
    --dry-run            Report rows and dollars per model that would change, without writing
  quota                  Claude account 5h/7d quota series + picker decisions
    --days <N>           Window in days (default 7)
  budget [--key <id>]    IU cap per key (rolling 30 days): portal cost vs the limit, drop-off, portal vs tracked per day/model
    --explain <model>    Day-by-day portal vs tracked for one model: tokens, implied rate, tracked cost by source
  iu-portal [--key <id>] Fetch the IU portal cost report now, every key unless given (ignores the 4 h throttle)
  stats                  Aggregated token + cost report (successful requests only)
    --by <dim>           Group by: source (default) | model | billing | day | machine | lane | account | iu_key | repo | role | subagent_type | effort
    --since <N>          Only the last N days
  window                 Share of the Max accounts' 5h / 7d windows (points of the window), by session, lane, role, ...
    --by <dim>           session (default) | lane | role | subagent_type | issue | repo | account
    --days <N>           Only the last N days (default 7)
    --top <N>            Rows shown (default 20)
    --account <id>       One account's windows only (iu | me | me2)
    --format <f>         plain (default) | json
  report weekly          Where the Max windows went in one ISO week: verdict, shares by lane / role / subagent type / skill,
                         cache ratio and compactions, top sessions, findings with effect tracking (week against the previous)
    --week <YYYY-Www>    ISO week (Monday 00:00 UTC to the next Monday); default the last full week
    --top <N>            Rows per table (default 10)
    --format <f>         md (default) | json
    --out <dir>          Also write <dir>/<week>.md and <week>.json (atomic); the paths go to stderr
  sources                Per-collector status: rows, error rate, last run, last note
  health                 Exit 1 when a source's newest row is older than its expected cadence (ingest also exits 1 then)
  billing-audit          Per-session claude-code billing check vs. the live hook log
    --since <N>          Only the last N days (default 3, matches log retention)
    --session <id>       Only this session
  pg-migrate             Apply migrations/pg/*.sql to the usage schema (USAGE_PG_URL)
  prices-sync            Daily: write usage.prices rows for aliased models whose catalog price changed
  prices-seed-history    One-off: seed usage.prices from LiteLLM's git history (--since YYYY-MM-DD, default 2026-04-01)
  help                   This message

ENV
  USAGE_PG_URL   Postgres URL (default: role usage on shared, password via secrets-run)
  USAGE_MACHINE  Override the machine label (default: macOS hardware model, e.g. "Mac mini (M2 Pro)")
  HERMES_DB      Override Hermes state.db path
  FEUER_DB       Override Feuer state.db path
  USAGE_IUMAC_HOST     ssh alias for the MacBook mirror (default "iumac")
  USAGE_IUMAC_MACHINE  Override the mirrored MacBook's machine label
  USAGE_REMOTE_DIR     Mirror root (default ~/.local/share/usage-tracker/remote)
  USAGE_CLAUDE_ACCOUNT_BIN  claude-account binary (default ~/.local/bin/claude-account)
  USAGE_ACCOUNT_PICKS  picker log (default ~/.local/share/claude-accounts/picks.jsonl)
  USAGE_IUMAC_DISABLE  Set to "1" to disable the MacBook mirror entirely
`;

const COMMANDS = new Set(["ingest", "health", "quota", "iu-portal", "stats", "sources", "billing-audit", "budget", "reprice", "window", "report"]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [, , cmdArg, ...rest] = process.argv;
  const cmd = cmdArg ?? "ingest";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const pgCode = await runPgCommand(cmd, rest);
  if (pgCode !== null) return pgCode;

  if (!COMMANDS.has(cmd)) {
    process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }

  const sql = connect();
  try {
    if (cmd === "ingest") {
      const summary = await runIngest(sql, {
        full: rest.includes("--full"),
        only: flag(rest, "--source"),
      });
      for (const r of summary.results) {
        const detail = r.note ? ` (${r.note})` : "";
        process.stdout.write(
          `${r.source.padEnd(14)} ${r.status.padEnd(8)} +${r.newRows} new / ${r.processed} seen${detail}\n`,
        );
      }
      const failed = summary.results.some((r) => r.status === "error");
      // Silent sources fail the run too, so jobrun/jobs-grade (and through it
      // the dev-host heartbeat) sees a moved or dead store.
      const only = flag(rest, "--source");
      // The summary line is written even when Postgres is gone by now: that is a failed run, not a lost one.
      let stale: Awaited<ReturnType<typeof staleSources>> = [];
      let staleError = false;
      try {
        stale = await staleSources(
          sql,
          only ? collectors.filter((c) => c.source === only) : [...collectors, ...iuPortalFreshnessAll],
        );
      } catch (err) {
        staleError = true;
        process.stderr.write(`staleness check failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      if (stale.length > 0) process.stderr.write(`${formatStale(stale)}\n`);
      process.stdout.write(`\ndb: postgres usage schema\n${formatRunSummary(summary)}\n`);
      if (summary.unpriced.length > 0) {
        const breakdown = summary.unpriced.map((m) => `${m.model}=${m.rows}`).join(" ");
        process.stdout.write(`unpriced by model: ${breakdown}\n`);
      }
      return failed || staleError || stale.length > 0 ? 1 : 0;
    }

    if (cmd === "health") {
      const stale = await staleSources(sql, [...collectors, ...iuPortalFreshnessAll]);
      if (stale.length === 0) {
        process.stdout.write("health: every source within its expected cadence\n");
        return 0;
      }
      process.stderr.write(`${formatStale(stale)}\n`);
      return 1;
    }

    if (cmd === "quota") {
      const daysRaw = flag(rest, "--days");
      const days = daysRaw === undefined ? 7 : Number(daysRaw);
      if (!Number.isFinite(days) || days <= 0) {
        process.stderr.write(`--days must be a positive number, got "${daysRaw}"\n`);
        return 2;
      }
      process.stdout.write(`${await formatQuotaReport(sql, days)}\n`);
      return 0;
    }

    if (cmd === "reprice") {
      const result = await reprice(sql, { model: flag(rest, "--model"), dryRun: rest.includes("--dry-run") });
      process.stdout.write(`${formatReprice(result)}\n`);
      return 0;
    }

    if (cmd === "budget") {
      const explain = flag(rest, "--explain");
      const keyFlag = flag(rest, "--key");
      if (keyFlag !== undefined && !iuKeyDef(keyFlag)) throw new Error(`--key must be one of: ${IU_KEYS.map((k) => k.id).join(", ")}`);
      if (explain) {
        process.stdout.write(`${formatExplain(await buildExplain(sql, explain, Date.now(), keyFlag ?? DEFAULT_IU_KEY), explain)}\n`);
        return 0;
      }
      // No --key: every registered key, each against its own cap.
      const keys = keyFlag ? [keyFlag] : IU_KEYS.map((k) => k.id);
      const reports = [];
      for (const k of keys) reports.push(formatBudget(await buildBudget(sql, Date.now(), k)));
      process.stdout.write(`${reports.join("\n\n")}\n`);
      return 0;
    }

    if (cmd === "iu-portal") {
      const keyFlag = flag(rest, "--key");
      const def = keyFlag === undefined ? undefined : iuKeyDef(keyFlag);
      if (keyFlag !== undefined && !def) throw new Error(`--key must be one of: ${IU_KEYS.map((k) => k.id).join(", ")}`);
      const cells = await collectPortal(sql, { force: true, keys: def ? [def] : undefined });
      process.stdout.write(`iu-portal: ${cells} daily cells stored\n`);
      return cells > 0 ? 0 : 1;
    }

    if (cmd === "stats") {
      const byRaw = flag(rest, "--by") ?? "source";
      const by = (byRaw === "api_key" ? "iu_key" : byRaw) as GroupBy;
      if (!GROUP_BY_DIMS.includes(by)) {
        process.stderr.write(`--by must be one of: ${GROUP_BY_DIMS.join(" | ")}, got "${byRaw}"\n`);
        return 2;
      }
      const sinceRaw = flag(rest, "--since");
      const rows = await stats(sql, { by, sinceDays: sinceRaw ? Number(sinceRaw) : undefined });
      process.stdout.write(`${formatStats(rows, by)}\n`);
      return 0;
    }

    if (cmd === "window") {
      // A flag without a value must not fall back to its default: `--account` alone would silently report every account.
      const missing = ["--by", "--days", "--top", "--account", "--format"].filter((f) => rest.includes(f) && (flag(rest, f) === undefined || flag(rest, f)?.startsWith("--")));
      if (missing.length > 0) {
        process.stderr.write(`${missing.join(", ")} needs a value\n`);
        return 2;
      }
      const by = (flag(rest, "--by") ?? "session") as WindowBy;
      if (!WINDOW_BY_DIMS.includes(by)) {
        process.stderr.write(`--by must be one of: ${WINDOW_BY_DIMS.join(" | ")}, got "${by}"\n`);
        return 2;
      }
      const daysRaw = flag(rest, "--days");
      const topRaw = flag(rest, "--top");
      const days = daysRaw === undefined ? 7 : Number(daysRaw);
      const top = topRaw === undefined ? 20 : Number(topRaw);
      if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(top) || top <= 0) {
        process.stderr.write("--days must be a positive number and --top a positive integer\n");
        return 2;
      }
      const format = flag(rest, "--format") ?? "plain";
      if (format !== "plain" && format !== "json") {
        process.stderr.write(`--format must be plain or json, got "${format}"\n`);
        return 2;
      }
      const report = await windowShare(sql, { by, days, top, account: flag(rest, "--account") });
      process.stdout.write(`${format === "json" ? JSON.stringify(report, null, 2) : formatWindow(report)}\n`);
      return 0;
    }

    if (cmd === "report") {
      if (rest[0] !== "weekly") {
        process.stderr.write(`report needs a subcommand: weekly, got "${rest[0] ?? ""}"\n`);
        return 2;
      }
      const missing = ["--week", "--top", "--format", "--out"].filter((f) => rest.includes(f) && (flag(rest, f) === undefined || flag(rest, f)?.startsWith("--")));
      if (missing.length > 0) {
        process.stderr.write(`${missing.join(", ")} needs a value\n`);
        return 2;
      }
      const weekRaw = flag(rest, "--week");
      try {
        if (weekRaw !== undefined) parseIsoWeek(weekRaw);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      const topRaw = flag(rest, "--top");
      const top = topRaw === undefined ? 10 : Number(topRaw);
      if (!Number.isInteger(top) || top <= 0) {
        process.stderr.write(`--top must be a positive integer, got "${topRaw}"\n`);
        return 2;
      }
      const format = flag(rest, "--format") ?? "md";
      if (format !== "md" && format !== "json") {
        process.stderr.write(`--format must be md or json, got "${format}"\n`);
        return 2;
      }
      const report = await weeklyReport(sql, { week: weekRaw, top, changes: loadChanges() });
      const outDir = flag(rest, "--out");
      if (outDir !== undefined) for (const path of writeWeekly(outDir, report)) process.stderr.write(`${path}\n`);
      process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatWeekly(report));
      return 0;
    }

    if (cmd === "sources") {
      process.stdout.write(`${formatSources(await sourceStatus(sql))}\n`);
      const unpriced = await unpricedByModel(sql);
      if (unpriced.length > 0) {
        const total = unpriced.reduce((sum, m) => sum + m.rows, 0);
        const breakdown = unpriced.map((m) => `${m.model}=${m.rows}`).join(" ");
        process.stdout.write(`\nunpriced: ${total} rows, cost_source='none' (${breakdown})\n`);
      }
      return 0;
    }

    // billing-audit
    const sinceRaw = flag(rest, "--since");
    const rows = await sessionBillingAudit(sql, {
      sinceDays: sinceRaw ? Number(sinceRaw) : 3,
      sessionId: flag(rest, "--session"),
    });
    process.stdout.write(`${formatBillingAudit(rows)}\n`);
    return 0;
  } finally {
    await sql.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
