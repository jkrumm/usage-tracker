import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { SCHEMA } from "./schema.ts";
import { currentMachine } from "./machine.ts";
import { classifyBilling, normalizeModel } from "./models.ts";
import { computeCost } from "./pricing.ts";
import type { CollectResult, UsageRecord } from "./types.ts";

/** Resolve the SQLite path: $USAGE_DB or ~/.local/share/usage-tracker/usage.db. */
export function dbPath(): string {
  return process.env.USAGE_DB ?? `${homedir()}/.local/share/usage-tracker/usage.db`;
}

export function openDb(path = dbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Forward-migrate an existing DB to the current schema. SCHEMA only creates
 * missing tables/indexes (CREATE … IF NOT EXISTS), so a column added to an
 * already-created table needs a guarded ALTER here. Each ALTER is keyed on the
 * live column set, making this idempotent and safe on every open.
 */
function migrate(db: Database): void {
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(usage_record)")
      .all()
      .map((r) => r.name),
  );
  if (!cols.has("machine")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN machine TEXT");
  }
  if (!cols.has("outcome")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ok'");
  }
  if (!cols.has("synced_at")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN synced_at TEXT");
  }
}

export interface UpsertSummary {
  processed: number;
  newRows: number;
}

const UPSERT_SQL = `
INSERT INTO usage_record
  (source, source_id, grain, ts, model, model_norm, project, billing, machine, outcome,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
   cost_usd, cost_source, raw, ingested_at)
VALUES
  ($source, $source_id, $grain, $ts, $model, $model_norm, $project, $billing, $machine, $outcome,
   $input, $output, $cache_read, $cache_write, $reasoning,
   $cost_usd, $cost_source, $raw, datetime('now'))
ON CONFLICT (source, source_id) DO UPDATE SET
  grain=excluded.grain, ts=excluded.ts, model=excluded.model,
  model_norm=excluded.model_norm, project=excluded.project, billing=excluded.billing,
  machine=excluded.machine, outcome=excluded.outcome,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
  cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  reasoning_tokens=excluded.reasoning_tokens,
  cost_usd=excluded.cost_usd, cost_source=excluded.cost_source, raw=excluded.raw,
  ingested_at=datetime('now');
`;

/**
 * Upsert a batch of records for one source. Derives model_norm, billing and
 * cost here so collectors stay dumb. Idempotent: re-ingesting the same
 * source_id updates the row (correct for sessions whose token counts grow).
 */
export function upsertRecords(
  db: Database,
  source: string,
  records: UsageRecord[],
): UpsertSummary {
  const before = countRows(db, source);
  const stmt = db.prepare(UPSERT_SQL);
  const machine = currentMachine();

  const tx = db.transaction((rows: UsageRecord[]) => {
    for (const r of rows) {
      const modelNorm = normalizeModel(r.model);
      const cost = computeCost(modelNorm, {
        input: r.inputTokens,
        output: r.outputTokens,
        cacheRead: r.cacheReadTokens,
        cacheWrite: r.cacheWriteTokens,
        reasoning: r.reasoningTokens,
      });
      stmt.run({
        $source: source,
        $source_id: r.sourceId,
        $grain: r.grain,
        $ts: r.ts,
        $model: r.model,
        $model_norm: modelNorm,
        $project: r.project,
        $billing: classifyBilling(source, r.model),
        $machine: machine,
        $outcome: r.outcome ?? "ok",
        $input: r.inputTokens,
        $output: r.outputTokens,
        $cache_read: r.cacheReadTokens,
        $cache_write: r.cacheWriteTokens,
        $reasoning: r.reasoningTokens,
        $cost_usd: cost.usd,
        $cost_source: cost.source,
        $raw: r.raw ? JSON.stringify(r.raw) : null,
      });
    }
  });
  tx(records);

  const after = countRows(db, source);
  return { processed: records.length, newRows: after - before };
}

function countRows(db: Database, source: string): number {
  const row = db
    .query<{ c: number }, [string]>("SELECT count(*) c FROM usage_record WHERE source = ?")
    .get(source);
  return row?.c ?? 0;
}

export interface CollectorState {
  cursor: string | null;
  recordsTotal: number;
}

export function loadCursor(db: Database, source: string): string | null {
  const row = db
    .query<{ cursor: string | null }, [string]>(
      "SELECT cursor FROM collector_state WHERE source = ?",
    )
    .get(source);
  return row?.cursor ?? null;
}

export function saveState(
  db: Database,
  source: string,
  args: { result: CollectResult; status: string; processed: number },
): void {
  db.prepare(
    `INSERT INTO collector_state (source, cursor, last_run_at, last_status, last_note, records_total)
     VALUES ($source, $cursor, datetime('now'), $status, $note,
       (SELECT count(*) FROM usage_record WHERE source = $source))
     ON CONFLICT (source) DO UPDATE SET
       cursor=excluded.cursor, last_run_at=excluded.last_run_at,
       last_status=excluded.last_status, last_note=excluded.last_note,
       records_total=excluded.records_total`,
  ).run({
    $source: source,
    $cursor: args.result.cursor,
    $status: args.status,
    $note: args.result.note ?? null,
  });
}
