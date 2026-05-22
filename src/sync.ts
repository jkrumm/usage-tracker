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
  billing: string;
  machine: string | null;
  outcome: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_source: string;
  raw: string | null;
  ingested_at: string;
}

const ELIGIBLE_SQL = `
SELECT id, source, source_id, grain, ts, model, model_norm, project, billing, machine, outcome,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
       cost_usd, cost_source, raw, ingested_at
FROM usage_record
WHERE synced_at IS NULL OR ingested_at > synced_at
ORDER BY id
LIMIT ?
`;

export async function sync(db: Database, opts: SyncOptions = {}): Promise<SyncResult> {
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
    billing: r.billing,
    machine: r.machine,
    outcome: r.outcome,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    reasoning_tokens: r.reasoning_tokens,
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
