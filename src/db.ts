import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { SCHEMA } from "./schema.ts";
import { currentMachine } from "./machine.ts";
import { classifyBilling, normalizeModel } from "./models.ts";
import { computeCost } from "./pricing.ts";
import type { CollectResult, UsageRecord, Workspace } from "./types.ts";

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
  if (!cols.has("sub_tool")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN sub_tool TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_usage_sub_tool ON usage_record (sub_tool)");
  }
  if (!cols.has("duration_ms")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN duration_ms INTEGER");
  }
  if (!cols.has("workspace")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN workspace TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_usage_workspace ON usage_record (workspace)");
  }
  if (!cols.has("cache_write_1h_tokens")) {
    db.exec(
      "ALTER TABLE usage_record ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0",
    );
  }
}

export interface UpsertSummary {
  processed: number;
  newRows: number;
}

const UPSERT_SQL = `
INSERT INTO usage_record
  (source, source_id, grain, ts, model, model_norm, project, workspace, sub_tool, billing, machine, outcome,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, duration_ms,
   cost_usd, cost_source, raw, ingested_at)
VALUES
  ($source, $source_id, $grain, $ts, $model, $model_norm, $project, $workspace, $sub_tool, $billing, $machine, $outcome,
   $input, $output, $cache_read, $cache_write, $cache_write_1h, $reasoning, $duration_ms,
   $cost_usd, $cost_source, $raw, datetime('now'))
ON CONFLICT (source, source_id) DO UPDATE SET
  grain=excluded.grain, ts=excluded.ts, model=excluded.model,
  model_norm=excluded.model_norm, project=excluded.project, workspace=excluded.workspace,
  sub_tool=excluded.sub_tool,
  billing=excluded.billing, machine=excluded.machine, outcome=excluded.outcome,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
  cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  cache_write_1h_tokens=excluded.cache_write_1h_tokens,
  reasoning_tokens=excluded.reasoning_tokens, duration_ms=excluded.duration_ms,
  cost_usd=excluded.cost_usd, cost_source=excluded.cost_source, raw=excluded.raw,
  ingested_at=datetime('now')
WHERE (usage_record.grain, usage_record.ts, usage_record.model, usage_record.model_norm,
       usage_record.project, usage_record.workspace, usage_record.sub_tool, usage_record.billing,
       usage_record.machine, usage_record.outcome,
       usage_record.input_tokens, usage_record.output_tokens, usage_record.cache_read_tokens,
       usage_record.cache_write_tokens, usage_record.cache_write_1h_tokens,
       usage_record.reasoning_tokens, usage_record.duration_ms,
       usage_record.cost_usd, usage_record.cost_source, usage_record.raw)
  IS NOT
      (excluded.grain, excluded.ts, excluded.model, excluded.model_norm,
       excluded.project, excluded.workspace, excluded.sub_tool, excluded.billing,
       excluded.machine, excluded.outcome,
       excluded.input_tokens, excluded.output_tokens, excluded.cache_read_tokens,
       excluded.cache_write_tokens, excluded.cache_write_1h_tokens,
       excluded.reasoning_tokens, excluded.duration_ms,
       excluded.cost_usd, excluded.cost_source, excluded.raw);
`;

/**
 * Upsert a batch of records for one source. Derives model_norm, billing and
 * cost here so collectors stay dumb. Idempotent: re-ingesting the same
 * source_id updates the row (correct for sessions whose token counts grow).
 *
 * The conflict branch only fires when something actually differs (the row-value
 * `IS NOT` above — NULL-safe), so `ingested_at` moves only on a real change.
 * That is what keeps the Argo sync (`ingested_at > synced_at`) a delta: the
 * hermes/feuer collectors re-read their whole `sessions` table every run, and
 * an unconditional update used to re-push ~2.5k unchanged rows each time.
 */
export function upsertRecords(
  db: Database,
  source: string,
  records: UsageRecord[],
  opts: { defaultWorkspace?: Workspace | null } = {},
): UpsertSummary {
  const before = countRows(db, source);
  const stmt = db.prepare(UPSERT_SQL);
  // One currentMachine() call per batch, not per record — a batch is one
  // collector run on one host. A record can still override it (r.machine ??
  // batchMachine below): the claude-code collector spans two hosts (local +
  // the iumac mirror) inside a single run, so per-record is the only place
  // that distinction can be made. No schema change needed — `machine` already
  // exists on usage_record.
  const batchMachine = currentMachine();
  const defaultWorkspace = opts.defaultWorkspace ?? null;

  const tx = db.transaction((rows: UsageRecord[]) => {
    for (const r of rows) {
      const modelNorm = normalizeModel(r.model);
      // A vendor-reported cost (research-gateway's sonar rows, sideclaw-iu's
      // gateway `usage.cost`) is authoritative — more accurate than this
      // table's pricing for a per-call vendor bill or a Bedrock/Azure-routed
      // model with no real cost field — and stored verbatim; everything else
      // is priced from tokens centrally.
      const cost =
        r.authoritativeCostUsd != null
          ? { usd: r.authoritativeCostUsd, source: "reported" as const }
          : computeCost(modelNorm, {
              input: r.inputTokens,
              output: r.outputTokens,
              cacheRead: r.cacheReadTokens,
              cacheWrite: r.cacheWriteTokens,
              cacheWrite1h: r.cacheWrite1hTokens ?? 0,
              reasoning: r.reasoningTokens,
              grain: r.grain,
            });
      stmt.run({
        $source: source,
        $source_id: r.sourceId,
        $grain: r.grain,
        $ts: r.ts,
        $model: r.model,
        $model_norm: modelNorm,
        $project: r.project,
        $workspace: r.workspace ?? defaultWorkspace,
        $sub_tool: r.subTool ?? null,
        $billing: classifyBilling(
          source,
          r.model,
          typeof r.raw?.sessionId === "string" ? r.raw.sessionId : undefined,
          typeof r.raw?.backend === "string" ? r.raw.backend : undefined,
        ),
        $machine: r.machine ?? batchMachine,
        $outcome: r.outcome ?? "ok",
        $input: r.inputTokens,
        $output: r.outputTokens,
        $cache_read: r.cacheReadTokens,
        $cache_write: r.cacheWriteTokens,
        $cache_write_1h: r.cacheWrite1hTokens ?? 0,
        $reasoning: r.reasoningTokens,
        $duration_ms: r.durationMs ?? null,
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
