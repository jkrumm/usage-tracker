import type { Database } from "bun:sqlite";
import { log } from "./log.ts";

export interface SyncOptions {
  /** Max records per request (default 500). */
  batchSize?: number;
  /** Safety limit on number of batches (default 200). */
  maxBatches?: number;
}

export interface SyncResult {
  pushed: number;
  batches: number;
}

interface DbRow {
  id: number;
  source: string;
  source_id: string;
  grain: string;
  ts: string;
  model: string | null;
  model_norm: string | null;
  project: string | null;
  workspace: string | null;
  sub_tool: string | null;
  billing: string;
  account: string | null;
  machine: string | null;
  outcome: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  duration_ms: number | null;
  cost_usd: number | null;
  cost_source: string;
  raw: string | null;
  ingested_at: string;
}

const ELIGIBLE_SQL = `
SELECT id, source, source_id, grain, ts, model, model_norm, project, workspace, sub_tool,
       billing, account, machine, outcome,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms,
       cost_usd, cost_source, raw, ingested_at
FROM usage_record
WHERE synced_at IS NULL OR ingested_at > synced_at
ORDER BY id
LIMIT ?
`;

/**
 * Re-queue every Max row for the next sync so Argo receives its `account`.
 * Run once, after Argo's ingest stores the field — before that the push would
 * be dropped on the floor. Returns the number of rows re-queued.
 */
export function resyncAccount(db: Database): number {
  return db.prepare("UPDATE usage_record SET synced_at = NULL WHERE billing = 'max'").run().changes;
}

/** Usage rows first, then the account tables; the latter never affect the former's result. */
export async function sync(db: Database, opts: SyncOptions = {}): Promise<SyncResult> {
  const result = await syncUsage(db, opts);
  await syncAccountTables(db);
  return result;
}

const ACCOUNT_BATCH = 1000;

interface QuotaRow {
  rowid: number;
  account: string;
  sampled_at: number;
  machine: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_resets_at: number | null;
  auth_ok: number | null;
  exhausted_until: number | null;
  source: string | null;
}

interface PickRow {
  rowid: number;
  ts: number;
  lane: string;
  picked: string;
  reason: string;
  stale: number;
  snapshot: string | null;
  machine: string;
}

const isoMs = (ms: number): string => new Date(ms).toISOString();
const isoSec = (s: number | null): string | null => (s == null ? null : isoMs(s * 1000));

/**
 * Push quota_sample and account_pick rows to Argo (`/usage/quota-samples`,
 * `/usage/account-picks`). A 404/405 means Argo has not shipped the endpoint
 * yet: rows stay unsynced and it is logged once per run at info, never an error.
 */
export async function syncAccountTables(db: Database): Promise<{ quota: number; picks: number }> {
  const argoUrl = process.env.ARGO_URL ?? "https://argo.jkrumm.com/api";
  const argoToken = process.env.ARGO_TOKEN;
  if (!argoToken) return { quota: 0, picks: 0 };

  const post = async (path: string, body: unknown): Promise<"ok" | "missing" | "failed"> => {
    try {
      const res = await fetch(`${argoUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${argoToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 405) {
        log.info(`sync: ${path} not available on Argo yet (HTTP ${res.status}); rows stay unsynced`);
        return "missing";
      }
      log.error(`sync failed: ${path} HTTP ${res.status} — ${(await res.text()).slice(0, 400)}`);
      return "failed";
    } catch (err) {
      log.error(`sync failed: ${path} network error: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
  };

  const pushTable = async <T extends { rowid: number }>(
    path: string,
    select: string,
    mark: string,
    toBody: (rows: T[]) => unknown,
  ): Promise<number> => {
    let pushed = 0;
    const markStmt = db.prepare(mark);
    for (;;) {
      const rows = db.query<T, [number]>(select).all(ACCOUNT_BATCH);
      if (rows.length === 0) return pushed;
      if ((await post(path, toBody(rows))) !== "ok") return pushed;
      db.transaction(() => {
        for (const r of rows) markStmt.run(r.rowid);
      })();
      pushed += rows.length;
    }
  };

  const quota = await pushTable<QuotaRow>(
    "/usage/quota-samples",
    `SELECT rowid, account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at,
            seven_day_resets_at, auth_ok, exhausted_until, source
     FROM quota_sample WHERE synced = 0 ORDER BY rowid LIMIT ?`,
    "UPDATE quota_sample SET synced = 1 WHERE rowid = ?",
    (rows) => ({
      samples: rows.map((r) => ({
        account: r.account,
        sampledAt: isoMs(r.sampled_at),
        machine: r.machine,
        fiveHourPct: r.five_hour_pct,
        sevenDayPct: r.seven_day_pct,
        fiveHourResetsAt: isoSec(r.five_hour_resets_at),
        sevenDayResetsAt: isoSec(r.seven_day_resets_at),
        authOk: r.auth_ok == null ? null : r.auth_ok === 1,
        exhaustedUntil: isoSec(r.exhausted_until),
        source: r.source,
      })),
    }),
  );
  const picks = await pushTable<PickRow>(
    "/usage/account-picks",
    `SELECT rowid, ts, lane, picked, reason, stale, snapshot, machine
     FROM account_pick WHERE synced = 0 ORDER BY rowid LIMIT ?`,
    "UPDATE account_pick SET synced = 1 WHERE rowid = ?",
    (rows) => ({
      picks: rows.map((r) => ({
        ts: isoMs(r.ts),
        lane: r.lane,
        picked: r.picked,
        reason: r.reason,
        stale: r.stale === 1,
        snapshot: safeJsonParse(r.snapshot),
        machine: r.machine,
      })),
    }),
  );
  if (quota > 0 || picks > 0) log.info(`sync: pushed ${quota} quota samples, ${picks} account picks`);
  return { quota, picks };
}

async function syncUsage(db: Database, opts: SyncOptions): Promise<SyncResult> {
  const argoUrl = process.env.ARGO_URL ?? "https://argo.jkrumm.com/api";
  const argoToken = process.env.ARGO_TOKEN;

  if (!argoToken) {
    log.info("sync disabled (no ARGO_TOKEN)");
    return { pushed: 0, batches: 0 };
  }

  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 200;
  const endpoint = `${argoUrl}/usage/records`;
  const stmt = db.query<DbRow, [number]>(ELIGIBLE_SQL);
  const updateStmt = db.prepare(
    "UPDATE usage_record SET synced_at = datetime('now') WHERE source = $source AND source_id = $source_id",
  );

  let pushed = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const rows = stmt.all(batchSize);
    if (rows.length === 0) break;

    const body = { records: rows.map((r) => rowToPayload(r)) };

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${argoToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`sync failed: network error: ${msg}`);
      return { pushed, batches };
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 400);
      log.error(`sync failed: HTTP ${res.status} ${res.statusText} — ${text}`);
      return { pushed, batches };
    }

    const tx = db.transaction((ids: Array<{ source: string; source_id: string }>) => {
      for (const id of ids) {
        updateStmt.run({ $source: id.source, $source_id: id.source_id });
      }
    });
    tx(rows.map((r) => ({ source: r.source, source_id: r.source_id })));

    pushed += rows.length;
    batches += 1;
  }

  return { pushed, batches };
}

function rowToPayload(r: DbRow): Record<string, unknown> {
  return {
    source: r.source,
    source_id: r.source_id,
    grain: r.grain,
    ts: r.ts,
    model: r.model,
    model_norm: r.model_norm,
    project: r.project,
    workspace: r.workspace,
    sub_tool: r.sub_tool,
    billing: r.billing,
    account: r.account,
    machine: r.machine,
    outcome: r.outcome,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    reasoning_tokens: r.reasoning_tokens,
    duration_ms: r.duration_ms,
    cost_usd: r.cost_usd,
    cost_source: r.cost_source,
    raw: safeJsonParse(r.raw),
    ingested_at: r.ingested_at,
  };
}

function safeJsonParse(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
