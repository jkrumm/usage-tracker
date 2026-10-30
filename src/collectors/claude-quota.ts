import type { SQL } from "bun";
import { homedir } from "node:os";
import { currentMachine } from "../machine.ts";
import { log } from "../log.ts";

// `claude-account usage --json` (dotfiles picker, cache-only, ~100 ms) reports
// the 5h/weekly quota of every Claude Max account. Not a records source:
// it is a time series per account, stored in usage.quota_samples. The binary
// only exists on the mini (and the MacBook mirror), so a missing binary is a
// silent skip.

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

const clampPct = (v: number | null): number | null => (v == null ? null : Math.min(100, Math.max(0, Math.round(v))));

/** ISO timestamp of an epoch, or null when it is not a representable date. */
function iso(epoch: number | null, unit: "s" | "ms"): string | null {
  if (epoch == null) return null;
  const d = new Date(unit === "s" ? epoch * 1000 : epoch);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Store one quota sample per enabled account that knows at least one window.
 * Returns the number of new rows. sampled_at = now - min(window ages), so a
 * cached reading that did not change since the last run dedupes (ON CONFLICT DO NOTHING).
 * Percentages are clamped to the column's 0-100 range; an unrepresentable epoch is stored as NULL.
 */
export async function collectQuota(sql: SQL, now = Date.now()): Promise<number> {
  const accounts = await readUsage();
  if (!accounts) return 0;

  const machine = currentMachine();
  const rows: Array<Record<string, unknown>> = [];
  for (const a of accounts) {
    if (!a.enabled) continue;
    if (a.five_hour == null && a.seven_day == null) continue;
    const ages = [a.five_hour_age_s, a.seven_day_age_s].filter((x): x is number => typeof x === "number");
    const age = ages.length > 0 ? Math.min(...ages) : 0;
    const sampledAt = iso(now - Math.round(age * 1000), "ms");
    if (!sampledAt) continue;
    rows.push({
      account: a.id,
      sampled_at: sampledAt,
      machine,
      five_hour_pct: clampPct(a.five_hour),
      seven_day_pct: clampPct(a.seven_day),
      five_hour_resets_at: iso(a.five_hour_resets_at, "s"),
      seven_day_resets_at: iso(a.seven_day_resets_at, "s"),
      auth_ok: a.auth_ok,
      exhausted_until: iso(a.exhausted_until, "s"),
      source: a.source,
    });
  }
  if (rows.length === 0) return 0;
  const inserted = await sql`
    INSERT INTO usage.quota_samples
      (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at, auth_ok,
       exhausted_until, source)
    SELECT account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at, auth_ok,
           exhausted_until, source
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS j(
      account text, sampled_at timestamptz, machine text, five_hour_pct integer, seven_day_pct integer,
      five_hour_resets_at timestamptz, seven_day_resets_at timestamptz, auth_ok boolean, exhausted_until timestamptz,
      source text)
    ORDER BY account, sampled_at
    ON CONFLICT (account, sampled_at, machine) DO NOTHING
    RETURNING 1`;
  return inserted.length;
}

/** Per-account 5h/7d series summary plus pick counts, for the last `days` days. */
export async function formatQuotaReport(sql: SQL, days = 7, now = Date.now()): Promise<string> {
  const since = new Date(now - days * 86_400_000).toISOString();
  const lines: string[] = [`quota — last ${days}d`];

  const series = await sql`
    SELECT account, count(*)::int n, min(five_hour_pct) f_min, max(five_hour_pct) f_max,
           min(seven_day_pct) s_min, max(seven_day_pct) s_max,
           (array_agg(five_hour_pct ORDER BY sampled_at DESC))[1] f_last,
           (array_agg(seven_day_pct ORDER BY sampled_at DESC))[1] s_last
    FROM usage.quota_samples WHERE sampled_at >= ${since}::timestamptz GROUP BY account ORDER BY account`;
  const fmt = (v: number | null) => (v == null ? "-" : String(v));
  if (series.length === 0) lines.push("no quota samples");
  for (const a of series) {
    lines.push(
      `${String(a.account).padEnd(6)} samples=${a.n}  5h min/max/last=${fmt(a.f_min)}/${fmt(a.f_max)}/${fmt(a.f_last)}%  7d min/max/last=${fmt(a.s_min)}/${fmt(a.s_max)}/${fmt(a.s_last)}%`,
    );
  }

  const picks = await sql`
    SELECT lane, picked, reason, count(*)::int n FROM usage.account_picks WHERE ts >= ${since}::timestamptz
    GROUP BY lane, picked, reason ORDER BY lane, picked, n DESC`;
  lines.push("", "picks (lane × picked × reason)");
  if (picks.length === 0) lines.push("no picks");
  for (const p of picks) lines.push(`${String(p.lane).padEnd(18)} ${String(p.picked).padEnd(6)} ${String(p.reason).padEnd(14)} ${p.n}`);
  return lines.join("\n");
}
