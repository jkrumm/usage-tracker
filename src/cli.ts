#!/usr/bin/env bun
import { dbPath, openDb } from "./db.ts";
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
  sessionBillingAudit,
  sourceStatus,
  staleSources,
  stats,
  unpricedByModel,
  type GroupBy,
} from "./report.ts";
import { formatRelane, relane, scanEntrypoints } from "./relane.ts";
import { checkPricingDrift, fetchRequestyModels } from "./pricing-drift.ts";
import { formatReprice, reprice } from "./reprice.ts";
import { runPgCommand } from "./pg/cli.ts";
import { resyncAccount, sync } from "./sync.ts";

const HELP = `usage-tracker — local token/cost telemetry across AI tools

USAGE
  usage-tracker <command> [options]

COMMANDS
  ingest                 Run all available collectors incrementally (default)
    --full               Ignore watermarks and re-scan everything
    --source <name>      Only run one collector (claude-code|hermes|feuer|opencode|litellm|agent-gateway-iu)
  sync                   Push eligible usage_record rows to the Argo API
  resync-account         Re-queue all billing=max rows for sync (run once, after Argo stores account)
  reprice                Re-cost stored rows against the current pricing table
    --model <norm>       Only this model_norm
    --dry-run            Report what would change without writing
  relane                 Backfill claude-code sub_tool from transcript entrypoints (interactive/headless/desktop)
    --dry-run            Report per old -> new lane counts and cost without writing
  quota                  Claude account 5h/7d quota series + picker decisions
    --days <N>           Window in days (default 7)
  budget [--key <id>]    IU cap per key (rolling 30 days): portal cost vs the limit, drop-off, portal vs tracked per day/model
    --explain <model>    Day-by-day portal vs tracked for one model: tokens, implied rate, tracked cost by source
  iu-portal [--key <id>] Fetch the IU portal cost report now, every key unless given (ignores the 4 h throttle)
  stats                  Aggregated token + cost report (successful requests only)
    --by <dim>           Group by: source (default) | model | billing | day | machine | sub_tool | account | iu_key
    --since <N>          Only the last N days
  sources                Per-collector status: rows, error rate, last run, last note
  health                 Exit 1 when a source's newest row is older than its expected cadence (ingest also exits 1 then)
  billing-audit          Per-session claude-code billing check vs. the live session_env log
    --since <N>          Only the last N days (default 3, matches log retention)
    --session <id>       Only this session
  pg-migrate             Apply migrations/pg/*.sql to the usage schema (USAGE_PG_URL)
  prices-sync            Daily: write usage.prices rows for aliased models whose catalog price changed
  prices-seed-history    One-off: seed usage.prices from LiteLLM's git history (--since YYYY-MM-DD, default 2026-04-01)
  pricing-drift          Read-only: compare PRICING peak rates against Requesty's public catalogue (exit 1 on drift >1%)
  help                   This message

ENV
  USAGE_DB       SQLite path (default ~/.local/share/usage-tracker/usage.db)
  USAGE_PG_URL   Postgres URL for the pg-* and prices-* commands (default: role usage on shared, password via secrets-run)
  USAGE_MACHINE  Override the machine label (default: macOS hardware model, e.g. "Mac mini (M2 Pro)")
  ARGO_URL       Argo API base URL (default https://argo.jkrumm.com/api)
  ARGO_TOKEN     Bearer token for Argo sync (if absent, sync is silently disabled)
  HERMES_DB      Override Hermes state.db path
  FEUER_DB       Override Feuer state.db path
  USAGE_IUMAC_HOST     ssh alias for the MacBook mirror (default "iumac")
  USAGE_IUMAC_MACHINE  Override the mirrored MacBook's machine label
  USAGE_REMOTE_DIR     Mirror root (default ~/.local/share/usage-tracker/remote)
  USAGE_CLAUDE_ACCOUNT_BIN  claude-account binary (default ~/.local/bin/claude-account)
  USAGE_ACCOUNT_PICKS  picker log (default ~/.local/share/claude-accounts/picks.jsonl)
  USAGE_IUMAC_DISABLE  Set to "1" to disable the MacBook mirror entirely
`;

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

  if (cmd === "pricing-drift") {
    const result = checkPricingDrift(await fetchRequestyModels());
    process.stdout.write(`${result.lines.join("\n")}\n`);
    return result.ok ? 0 : 1;
  }

  const pgCode = await runPgCommand(cmd, rest);
  if (pgCode !== null) return pgCode;

  const db = openDb();
  try {
    if (cmd === "ingest") {
      const summary = await runIngest(db, {
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
      const stale = staleSources(
        db,
        only ? collectors.filter((c) => c.source === only) : [...collectors, ...iuPortalFreshnessAll],
      );
      if (stale.length > 0) process.stderr.write(`${formatStale(stale)}\n`);
      process.stdout.write(`\ndb: ${dbPath()}\n${formatRunSummary(summary)}\n`);
      if (summary.unpriced.length > 0) {
        const breakdown = summary.unpriced.map((m) => `${m.model}=${m.rows}`).join(" ");
        process.stdout.write(`unpriced by model: ${breakdown}\n`);
      }
      return failed || stale.length > 0 ? 1 : 0;
    }

    if (cmd === "health") {
      const stale = staleSources(db, [...collectors, ...iuPortalFreshnessAll]);
      if (stale.length === 0) {
        process.stdout.write("health: every source within its expected cadence\n");
        return 0;
      }
      process.stderr.write(`${formatStale(stale)}\n`);
      return 1;
    }

    if (cmd === "sync") {
      const { pushed, batches } = await sync(db);
      process.stdout.write(`sync: ${pushed} records pushed in ${batches} batch${batches === 1 ? "" : "es"}\n`);
      return 0;
    }

    if (cmd === "reprice") {
      const result = reprice(db, {
        model: flag(rest, "--model"),
        dryRun: rest.includes("--dry-run"),
      });
      process.stdout.write(`${formatReprice(result)}\n`);
      return 0;
    }

    if (cmd === "resync-account") {
      process.stdout.write(`${resyncAccount(db)} max rows re-queued for sync\n`);
      return 0;
    }

    if (cmd === "relane") {
      const result = relane(db, await scanEntrypoints(), { dryRun: rest.includes("--dry-run") });
      process.stdout.write(`${formatRelane(result)}\n`);
      return 0;
    }

    if (cmd === "quota") {
      const daysRaw = flag(rest, "--days");
      const days = daysRaw === undefined ? 7 : Number(daysRaw);
      if (!Number.isFinite(days) || days <= 0) {
        process.stderr.write(`--days must be a positive number, got "${daysRaw}"\n`);
        return 2;
      }
      process.stdout.write(`${formatQuotaReport(db, days)}\n`);
      return 0;
    }

    if (cmd === "budget") {
      const explain = flag(rest, "--explain");
      const keyFlag = flag(rest, "--key");
      if (keyFlag !== undefined && !iuKeyDef(keyFlag)) throw new Error(`--key must be one of: ${IU_KEYS.map((k) => k.id).join(", ")}`);
      if (explain) {
        process.stdout.write(`${formatExplain(buildExplain(db, explain, Date.now(), keyFlag ?? DEFAULT_IU_KEY), explain)}\n`);
        return 0;
      }
      // No --key: every registered key, each against its own cap.
      const keys = keyFlag ? [keyFlag] : IU_KEYS.map((k) => k.id);
      process.stdout.write(`${keys.map((k) => formatBudget(buildBudget(db, Date.now(), k))).join("\n\n")}\n`);
      return 0;
    }

    if (cmd === "iu-portal") {
      const keyFlag = flag(rest, "--key");
      const def = keyFlag === undefined ? undefined : iuKeyDef(keyFlag);
      if (keyFlag !== undefined && !def) throw new Error(`--key must be one of: ${IU_KEYS.map((k) => k.id).join(", ")}`);
      const cells = await collectPortal(db, { force: true, keys: def ? [def] : undefined });
      process.stdout.write(`iu-portal: ${cells} daily cells stored\n`);
      return cells > 0 ? 0 : 1;
    }

    if (cmd === "stats") {
      const by = (flag(rest, "--by") ?? "source") as GroupBy;
      const sinceRaw = flag(rest, "--since");
      const rows = stats(db, { by, sinceDays: sinceRaw ? Number(sinceRaw) : undefined });
      process.stdout.write(`${formatStats(rows, by)}\n`);
      return 0;
    }

    if (cmd === "sources") {
      process.stdout.write(`${formatSources(sourceStatus(db))}\n`);
      const unpriced = unpricedByModel(db);
      if (unpriced.length > 0) {
        const total = unpriced.reduce((sum, m) => sum + m.rows, 0);
        const breakdown = unpriced.map((m) => `${m.model}=${m.rows}`).join(" ");
        process.stdout.write(`\nunpriced: ${total} rows, cost_source='none' (${breakdown})\n`);
      }
      return 0;
    }

    if (cmd === "billing-audit") {
      const sinceRaw = flag(rest, "--since");
      const rows = sessionBillingAudit(db, {
        sinceDays: sinceRaw ? Number(sinceRaw) : 3,
        sessionId: flag(rest, "--session"),
      });
      process.stdout.write(`${formatBillingAudit(rows)}\n`);
      return 0;
    }

    process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  } finally {
    db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
