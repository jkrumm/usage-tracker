import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { payload } from "./pg/writer.ts";

// One-off import of the SQLite archive's non-record tables into the usage schema (scripts/import-sqlite-state.ts):
// collector_state, session_env, quota_sample, account_pick, iu_portal_cost, iu_portal_total. Idempotent and safe to re-run
// at cutover: every statement is insert-if-absent, or newer-wins where the table says "latest fetch wins", so a re-run
// can never overwrite what the Postgres pipeline has written since.

/** Bookkeeping of the retired Argo sync: nothing reads it after the cutover. */
export const SKIPPED_STATE_KEYS: ReadonlySet<string> = new Set(["argo_portal_fetched_at"]);

const CHUNK = 1000;

/** SQLite's `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string to ISO; null when empty or unparseable. */
export function sqliteTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const fromMs = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null);
const fromSec = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null);
const pct = (v: unknown): number | null => (typeof v === "number" && v >= 0 && v <= 100 ? Math.round(v) : null);
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) !== 0);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

type Row = Record<string, unknown>;

export const toCollectorState = (r: Row) => ({
  source: r.source as string,
  cursor: text(r.cursor),
  last_run_at: sqliteTime(r.last_run_at),
  last_status: text(r.last_status),
  last_note: text(r.last_note),
  records_total: typeof r.records_total === "number" ? r.records_total : 0,
});

export const toSessionEnv = (r: Row) => ({
  session: r.session as string,
  base_url: text(r.base_url),
  lane: text(r.lane),
  account: text(r.account),
  seen_at: sqliteTime(r.seen_at) ?? new Date(0).toISOString(),
});

export const toQuotaSample = (r: Row) => ({
  account: r.account as string,
  sampled_at: fromMs(r.sampled_at) as string,
  machine: r.machine as string,
  five_hour_pct: pct(r.five_hour_pct),
  seven_day_pct: pct(r.seven_day_pct),
  five_hour_resets_at: fromSec(r.five_hour_resets_at),
  seven_day_resets_at: fromSec(r.seven_day_resets_at),
  auth_ok: bool(r.auth_ok),
  exhausted_until: fromSec(r.exhausted_until),
  source: text(r.source),
});

export const toAccountPick = (r: Row) => ({
  ts: fromMs(r.ts) as string,
  lane: r.lane as string,
  picked: r.picked as string,
  reason: r.reason as string,
  stale: bool(r.stale) ?? false,
  snapshot: parseJson(r.snapshot),
  machine: r.machine as string,
});

export const toPortalCost = (r: Row) => ({
  iu_key: (text(r.iu_key) ?? "personal") as string,
  day: r.day as string,
  label: r.label as string,
  row: r.row as number,
  model: text(r.model),
  cost_usd: r.cost_usd as number,
  fetched_at: fromMs(r.fetched_at) as string,
});

export const toPortalTotal = (r: Row) => ({
  iu_key: (text(r.iu_key) ?? "personal") as string,
  month: r.month as string,
  total_usd: r.total_usd as number,
  fetched_at: fromMs(r.fetched_at) as string,
});

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function inChunks<T>(rows: T[], run: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await run(rows.slice(i, i + CHUNK));
}

export interface StateImportCounts {
  read: number;
  /** Rows that were not in the table before (a refreshed row does not count). */
  added: number;
  skipped?: string[];
}

export type StateImportResult = Record<"collector_state" | "session_env" | "quota_samples" | "account_picks" | "iu_portal_cost" | "iu_portal_total", StateImportCounts>;

async function count(sql: SQL, query: string): Promise<number> {
  const [r] = await sql.unsafe(query);
  return Number(r.n);
}

/**
 * Copy the six state tables from the SQLite archive. `collector_state` is insert-if-absent (the Postgres pipeline owns a
 * cursor once it has run), `session_env` and the portal tables take the newer line, the two Max-account series insert
 * what is absent (their primary keys carry the whole observation).
 */
export async function importState(db: Database, sql: SQL): Promise<StateImportResult> {
  const all = (q: string): Row[] => db.query(q).all() as Row[];
  const result = {} as StateImportResult;
  const before = async (table: string): Promise<number> => count(sql, `SELECT count(*)::int AS n FROM usage.${table}`);

  const states = all("SELECT source, cursor, last_run_at, last_status, last_note, records_total FROM collector_state");
  const skipped = states.filter((r) => SKIPPED_STATE_KEYS.has(r.source as string)).map((r) => r.source as string);
  const stateRows = states.filter((r) => !SKIPPED_STATE_KEYS.has(r.source as string)).map(toCollectorState);
  let b = await before("collector_state");
  await inChunks(stateRows, async (chunk) => {
    await sql`
      INSERT INTO usage.collector_state (source, cursor, last_run_at, last_status, last_note, records_total)
      SELECT source, cursor, last_run_at, last_status, last_note, records_total
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb)
        AS j(source text, cursor text, last_run_at timestamptz, last_status text, last_note text, records_total bigint)
      ON CONFLICT (source) DO NOTHING`;
  });
  result.collector_state = { read: states.length, added: (await before("collector_state")) - b, skipped };

  b = await before("session_env");
  const envRows = all("SELECT session, base_url, lane, account, seen_at FROM session_env").map(toSessionEnv);
  await inChunks(envRows, async (chunk) => {
    await sql`
      INSERT INTO usage.session_env AS e (session, base_url, lane, account, seen_at)
      SELECT session, base_url, lane, account, seen_at
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb)
        AS j(session text, base_url text, lane text, account text, seen_at timestamptz)
      ORDER BY session
      ON CONFLICT (session) DO UPDATE SET
        base_url = EXCLUDED.base_url, lane = EXCLUDED.lane, account = coalesce(EXCLUDED.account, e.account), seen_at = EXCLUDED.seen_at
      WHERE EXCLUDED.seen_at > e.seen_at`;
  });
  result.session_env = { read: envRows.length, added: (await before("session_env")) - b };

  const quota = all("SELECT account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at, auth_ok, exhausted_until, source FROM quota_sample").map(toQuotaSample);
  b = await before("quota_samples");
  await inChunks(quota, async (chunk) => {
    await sql`
      INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at,
                                       seven_day_resets_at, auth_ok, exhausted_until, source)
      SELECT account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at, auth_ok, exhausted_until, source
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb)
        AS j(account text, sampled_at timestamptz, machine text, five_hour_pct integer, seven_day_pct integer,
             five_hour_resets_at timestamptz, seven_day_resets_at timestamptz, auth_ok boolean, exhausted_until timestamptz, source text)
      ORDER BY account, sampled_at, machine
      ON CONFLICT (account, sampled_at, machine) DO NOTHING`;
  });
  result.quota_samples = { read: quota.length, added: (await before("quota_samples")) - b };

  const picks = all("SELECT ts, lane, picked, reason, stale, snapshot, machine FROM account_pick").map(toAccountPick);
  b = await before("account_picks");
  await inChunks(picks, async (chunk) => {
    await sql`
      INSERT INTO usage.account_picks (ts, lane, picked, reason, stale, snapshot, machine)
      SELECT ts, lane, picked, reason, stale, snapshot, machine
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb)
        AS j(ts timestamptz, lane text, picked text, reason text, stale boolean, snapshot jsonb, machine text)
      ORDER BY ts, lane, machine
      ON CONFLICT (ts, lane, machine) DO NOTHING`;
  });
  result.account_picks = { read: picks.length, added: (await before("account_picks")) - b };

  const cost = all("SELECT iu_key, day, label, row, model, cost_usd, fetched_at FROM iu_portal_cost").map(toPortalCost);
  b = await before("iu_portal_cost");
  await inChunks(cost, async (chunk) => {
    await sql`
      INSERT INTO usage.iu_portal_cost AS c (iu_key, day, label, "row", model, cost_usd, fetched_at)
      SELECT iu_key, day, label, "row", model, cost_usd, fetched_at
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb)
        AS j(iu_key text, day date, label text, "row" integer, model text, cost_usd numeric, fetched_at timestamptz)
      ORDER BY iu_key, day, label, "row"
      ON CONFLICT (iu_key, day, label, "row") DO UPDATE SET model = EXCLUDED.model, cost_usd = EXCLUDED.cost_usd, fetched_at = EXCLUDED.fetched_at
      WHERE EXCLUDED.fetched_at > c.fetched_at`;
  });
  result.iu_portal_cost = { read: cost.length, added: (await before("iu_portal_cost")) - b };

  const totals = all("SELECT iu_key, month, total_usd, fetched_at FROM iu_portal_total").map(toPortalTotal);
  b = await before("iu_portal_total");
  await inChunks(totals, async (chunk) => {
    await sql`
      INSERT INTO usage.iu_portal_total AS t (iu_key, month, total_usd, fetched_at)
      SELECT iu_key, month, total_usd, fetched_at
      FROM jsonb_to_recordset(${payload(chunk)}::text::jsonb) AS j(iu_key text, month text, total_usd numeric, fetched_at timestamptz)
      ORDER BY iu_key, month
      ON CONFLICT (iu_key, month) DO UPDATE SET total_usd = EXCLUDED.total_usd, fetched_at = EXCLUDED.fetched_at
      WHERE EXCLUDED.fetched_at > t.fetched_at`;
  });
  result.iu_portal_total = { read: totals.length, added: (await before("iu_portal_total")) - b };

  return result;
}
