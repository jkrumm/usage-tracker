import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { currentMachine } from "../machine.ts";
import { log } from "../log.ts";

// `claude-account usage --json` (dotfiles picker, cache-only, ~100 ms) reports
// the 5h/weekly quota of every Claude Max account. Not a usage_record source:
// it is a time series per account, stored in quota_sample and synced to Argo
// separately. The binary only exists on the mini (and the MacBook mirror), so
// a missing binary is a silent skip.

const TIMEOUT_MS = 5_000;
const SCRUBBED_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

interface AccountUsage {
  id: string;
  enabled: boolean;
  five_hour: number | null;
  seven_day: number | null;
  five_hour_resets_at: number | null;
  seven_day_resets_at: number | null;
  five_hour_age_s: number | null;
  seven_day_age_s: number | null;
  auth_ok: boolean | null;
  exhausted_until: number | null;
  source: string | null;
}

function binary(): string {
  return process.env.USAGE_CLAUDE_ACCOUNT_BIN ?? `${homedir()}/.local/bin/claude-account`;
}

const numOrNull = (v: unknown): number | null | undefined =>
  v == null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Validate one CLI account entry; null when malformed (the caller skips it). */
export function parseAccountUsage(raw: unknown): AccountUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  const nums = [r.five_hour, r.seven_day, r.five_hour_resets_at, r.seven_day_resets_at, r.five_hour_age_s, r.seven_day_age_s, r.exhausted_until].map(numOrNull);
  if (nums.some((n) => n === undefined)) return null;
  const [five, seven, fiveReset, sevenReset, fiveAge, sevenAge, exhausted] = nums as Array<number | null>;
  if ((fiveAge ?? 0) < 0 || (sevenAge ?? 0) < 0) return null;
  if (r.auth_ok != null && typeof r.auth_ok !== "boolean") return null;
  if (r.source != null && typeof r.source !== "string") return null;
  return {
    id: r.id,
    enabled: r.enabled !== false,
    five_hour: five!,
    seven_day: seven!,
    five_hour_resets_at: fiveReset!,
    seven_day_resets_at: sevenReset!,
    five_hour_age_s: fiveAge!,
    seven_day_age_s: sevenAge!,
    auth_ok: (r.auth_ok as boolean | null | undefined) ?? null,
    exhausted_until: exhausted!,
    source: (r.source as string | null | undefined) ?? null,
  };
}

/**
 * `claude-account usage --json` accounts, or null when the CLI is absent
 * (silent) or fails (warned). Bad individual entries are skipped, the rest kept.
 */
async function readUsage(): Promise<AccountUsage[] | null> {
  const bin = binary();
  if (!(await Bun.file(bin).exists())) return null;
  const env = { ...process.env };
  for (const k of SCRUBBED_ENV) delete env[k];
  try {
    const proc = Bun.spawn([bin, "usage", "--json"], {
      env,
      stdout: "pipe",
      stderr: "ignore",
      timeout: TIMEOUT_MS,
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (proc.signalCode) {
      log.warn(`claude-quota: claude-account killed by ${proc.signalCode} (timeout ${TIMEOUT_MS} ms?)`);
      return null;
    }
    if (code !== 0) {
      log.warn(`claude-quota: claude-account exited ${code}`);
      return null;
    }
    const parsed = JSON.parse(out) as { accounts?: unknown };
    if (!Array.isArray(parsed.accounts)) {
      log.warn("claude-quota: claude-account output has no accounts array");
      return null;
    }
    const accounts: AccountUsage[] = [];
    for (const raw of parsed.accounts) {
      const a = parseAccountUsage(raw);
      if (a) accounts.push(a);
      else log.warn(`claude-quota: skipping malformed account entry ${JSON.stringify(raw)?.slice(0, 120)}`);
    }
    return accounts;
  } catch (err) {
    log.warn(`claude-quota: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Store one quota sample per enabled account that knows at least one window.
 * Returns the number of new rows. sampled_at = now - min(window ages), so a
 * cached reading that did not change since the last run dedupes (INSERT OR IGNORE).
 */
export async function collectQuota(db: Database, now = Date.now()): Promise<number> {
  const accounts = await readUsage();
  if (!accounts) return 0;

  const machine = currentMachine();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO quota_sample
       (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at,
        seven_day_resets_at, auth_ok, exhausted_until, source)
     VALUES ($account, $sampled_at, $machine, $five, $seven, $five_reset, $seven_reset, $auth_ok, $exhausted, $source)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const a of accounts) {
      if (!a.enabled) continue;
      if (a.five_hour == null && a.seven_day == null) continue;
      const ages = [a.five_hour_age_s, a.seven_day_age_s].filter((x): x is number => typeof x === "number");
      const age = ages.length > 0 ? Math.min(...ages) : 0;
      added += stmt.run({
        $account: a.id,
        $sampled_at: now - Math.round(age * 1000),
        $machine: machine,
        $five: a.five_hour,
        $seven: a.seven_day,
        $five_reset: a.five_hour_resets_at,
        $seven_reset: a.seven_day_resets_at,
        $auth_ok: a.auth_ok == null ? null : a.auth_ok ? 1 : 0,
        $exhausted: a.exhausted_until,
        $source: a.source,
      }).changes;
    }
  })();
  return added;
}

/** Per-account 5h/7d series summary plus pick counts, for the last `days` days. */
export function formatQuotaReport(db: Database, days = 7, now = Date.now()): string {
  const since = now - days * 86_400_000;
  const lines: string[] = [`quota — last ${days}d`];

  const series = db
    .query<
      { account: string; n: number; f_min: number | null; f_max: number | null; s_min: number | null; s_max: number | null },
      [number]
    >(
      `SELECT account, count(*) n, min(five_hour_pct) f_min, max(five_hour_pct) f_max,
              min(seven_day_pct) s_min, max(seven_day_pct) s_max
       FROM quota_sample WHERE sampled_at >= ? GROUP BY account ORDER BY account`,
    )
    .all(since);
  const last = db.query<{ five_hour_pct: number | null; seven_day_pct: number | null }, [string, number]>(
    `SELECT five_hour_pct, seven_day_pct FROM quota_sample WHERE account = ? AND sampled_at >= ?
     ORDER BY sampled_at DESC LIMIT 1`,
  );
  const fmt = (v: number | null) => (v == null ? "-" : String(v));
  if (series.length === 0) lines.push("no quota samples");
  for (const a of series) {
    const l = last.get(a.account, since);
    lines.push(
      `${a.account.padEnd(6)} samples=${a.n}  5h min/max/last=${fmt(a.f_min)}/${fmt(a.f_max)}/${fmt(l?.five_hour_pct ?? null)}%  7d min/max/last=${fmt(a.s_min)}/${fmt(a.s_max)}/${fmt(l?.seven_day_pct ?? null)}%`,
    );
  }

  const picks = db
    .query<{ lane: string; picked: string; reason: string; n: number }, [number]>(
      `SELECT lane, picked, reason, count(*) n FROM account_pick WHERE ts >= ?
       GROUP BY lane, picked, reason ORDER BY lane, picked, n DESC`,
    )
    .all(since);
  lines.push("", "picks (lane × picked × reason)");
  if (picks.length === 0) lines.push("no picks");
  for (const p of picks) lines.push(`${p.lane.padEnd(18)} ${p.picked.padEnd(6)} ${p.reason.padEnd(14)} ${p.n}`);
  return lines.join("\n");
}
