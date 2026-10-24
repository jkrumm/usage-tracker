import type { Database } from "bun:sqlite";
import { argoConfig, postJson } from "./argo.ts";
import { log } from "./log.ts";
import { syncAccountTables } from "./sync-account.ts";

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

/**
 * Usage rows first, then the account tables. The account push is best-effort:
 * whatever it does (404, 500, network failure, a throw) is logged and never
 * changes the usage SyncResult.
 */
export async function sync(db: Database, opts: SyncOptions = {}): Promise<SyncResult> {
  const result = await syncUsage(db, opts);
  try {
    await syncAccountTables(db);
  } catch (err) {
    log.error(`sync: account tables: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

async function syncUsage(db: Database, opts: SyncOptions): Promise<SyncResult> {
  const cfg = argoConfig();
  if (!cfg) {
    log.info("sync disabled (no ARGO_TOKEN)");
    return { pushed: 0, batches: 0 };
  }

  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatches ?? 200;
  const stmt = db.query<DbRow, [number]>(ELIGIBLE_SQL);
  const updateStmt = db.prepare(
    // Conditional on the pushed snapshot: a row rewritten (account, ingested_at)
    // between the SELECT and this mark stays eligible for the next push.
    `UPDATE usage_record SET synced_at = datetime('now')
     WHERE source = $source AND source_id = $source_id AND account IS $account AND ingested_at = $ingested_at`,
  );

  let pushed = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const rows = stmt.all(batchSize);
    if (rows.length === 0) break;

    const body = { records: rows.map((r) => rowToPayload(r)) };

    if ((await postJson(cfg, "/usage/records", body)) !== "ok") return { pushed, batches };

    db.transaction(() => {
      for (const r of rows) {
        updateStmt.run({
          $source: r.source,
          $source_id: r.source_id,
          $account: r.account,
          $ingested_at: r.ingested_at,
        });
      }
    })();

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
