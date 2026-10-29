import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { SCHEMA } from "./schema.ts";
import { currentMachine } from "./machine.ts";
import { resolveIuKey } from "./iu-keys.ts";
import { classifyBilling, normalizeModel, resolveAccount } from "./models.ts";
import { computeCost, IGNORE_REPORTED_COST } from "./pricing.ts";
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
  // Columns + one-off repairs in one BEGIN IMMEDIATE transaction (SQLite DDL
  // rolls back), so an interrupted first run cannot leave a column without its
  // backfill and two concurrent opens cannot both migrate: the columns are
  // re-read inside the write lock. Probes outside it keep every normal open
  // (stats, health, …) off the write lock. The repairs are gated on PRAGMA
  // user_version, never on the data: a Max row with a NULL account written after
  // the migration is a collector bug and must stay NULL (visible to
  // `claude-accounts-verify`), not be rewritten on the next open. The migration
  // (a) repairs pre-account Max rows with a NULL account as 'iu' and (b) renames
  // legacy ids 'a'/'b' to 'iu'/'me'. synced_at is left alone on purpose —
  // re-pushing every Max row while Argo still drops `account` would be wasted;
  // `resync-account` does it once Argo stores it.
  migrateAccount(db, cols);
  migrateIuKey(db);
}

function migrateAccount(db: Database, cols: Set<string>): void {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  const needsAccount =
    version < ACCOUNT_MIGRATION_VERSION || !cols.has("account") || !tableColumns(db, "session_env").has("account");
  if (!needsAccount) return;
  db.transaction(() => {
    if (!tableColumns(db, "usage_record").has("account")) db.exec("ALTER TABLE usage_record ADD COLUMN account TEXT");
    if (!tableColumns(db, "session_env").has("account")) db.exec("ALTER TABLE session_env ADD COLUMN account TEXT");
    if (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version >= ACCOUNT_MIGRATION_VERSION) return;
    db.exec("UPDATE usage_record SET account = 'iu' WHERE billing = 'max' AND account IS NULL");
    renameLegacyAccounts(db, "usage_record");
    renameLegacyAccounts(db, "session_env");
    db.exec(`PRAGMA user_version = ${ACCOUNT_MIGRATION_VERSION}`);
  }).immediate();
}

/** user_version once Max rows have an account and legacy ids a/b are renamed to iu/me. */
const ACCOUNT_MIGRATION_VERSION = 2;

/** user_version once IU rows carry the key they were billed to and the portal tables are per key. */
const IU_KEY_MIGRATION_VERSION = 3;

/**
 * Per-key IU spend. Every `billing='iu'` row before the dimension used the personal
 * key, so the backfill is 'personal' (never data-gated afterwards: a later NULL IU
 * row is a bug, not something to rewrite on open). The portal tables gain `iu_key`
 * in their primary key, which SQLite can only do by rebuilding them; the portal is
 * refetched anyway, so the copy only keeps the history readable meanwhile. synced_at
 * stays: Argo treats a missing key as 'personal', so nothing needs re-pushing.
 */
function migrateIuKey(db: Database): void {
  const needs =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version < IU_KEY_MIGRATION_VERSION ||
    !tableColumns(db, "usage_record").has("iu_key") ||
    !tableColumns(db, "iu_portal_cost").has("iu_key") ||
    !tableColumns(db, "iu_portal_total").has("iu_key");
  if (!needs) return;
  db.transaction(() => {
    let added = false;
    if (!tableColumns(db, "usage_record").has("iu_key")) {
      db.exec("ALTER TABLE usage_record ADD COLUMN iu_key TEXT");
      added = true;
    }
    if (!tableColumns(db, "iu_portal_cost").has("iu_key")) {
      db.exec(`
        ALTER TABLE iu_portal_cost RENAME TO iu_portal_cost_old;
        CREATE TABLE iu_portal_cost (
          iu_key TEXT NOT NULL DEFAULT 'personal', day TEXT NOT NULL, label TEXT NOT NULL, row INTEGER NOT NULL,
          model TEXT, cost_usd REAL NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (iu_key, day, label, row)
        );
        INSERT INTO iu_portal_cost SELECT 'personal', day, label, row, model, cost_usd, fetched_at FROM iu_portal_cost_old;
        DROP TABLE iu_portal_cost_old;`);
    }
    if (!tableColumns(db, "iu_portal_total").has("iu_key")) {
      db.exec(`
        ALTER TABLE iu_portal_total RENAME TO iu_portal_total_old;
        CREATE TABLE iu_portal_total (
          iu_key TEXT NOT NULL DEFAULT 'personal', month TEXT NOT NULL, total_usd REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (iu_key, month)
        );
        INSERT INTO iu_portal_total SELECT 'personal', month, total_usd, fetched_at FROM iu_portal_total_old;
        DROP TABLE iu_portal_total_old;`);
    }
    if (!added && db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version >= IU_KEY_MIGRATION_VERSION) return;
    db.exec("UPDATE usage_record SET iu_key = 'personal' WHERE billing = 'iu' AND iu_key IS NULL");
    db.exec(`PRAGMA user_version = ${IU_KEY_MIGRATION_VERSION}`);
  }).immediate();
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name),
  );
}

function renameLegacyAccounts(db: Database, table: "usage_record" | "session_env"): void {
  db.exec(
    `UPDATE ${table} SET account = CASE account WHEN 'a' THEN 'iu' WHEN 'b' THEN 'me' END WHERE account IN ('a', 'b')`,
  );
}

export interface UpsertSummary {
  processed: number;
  newRows: number;
}

const UPSERT_SQL = `
INSERT INTO usage_record
  (source, source_id, grain, ts, model, model_norm, project, workspace, sub_tool, billing, account, iu_key, machine, outcome,
   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, duration_ms,
   cost_usd, cost_source, raw, ingested_at)
VALUES
  ($source, $source_id, $grain, $ts, $model, $model_norm, $project, $workspace, $sub_tool, $billing, $account, $iu_key, $machine, $outcome,
   $input, $output, $cache_read, $cache_write, $cache_write_1h, $reasoning, $duration_ms,
   $cost_usd, $cost_source, $raw, datetime('now'))
ON CONFLICT (source, source_id) DO UPDATE SET
  grain=excluded.grain, ts=excluded.ts, model=excluded.model,
  model_norm=excluded.model_norm, project=excluded.project, workspace=excluded.workspace,
  sub_tool=excluded.sub_tool,
  billing=excluded.billing, account=excluded.account, iu_key=excluded.iu_key, machine=excluded.machine, outcome=excluded.outcome,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
  cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  cache_write_1h_tokens=excluded.cache_write_1h_tokens,
  reasoning_tokens=excluded.reasoning_tokens, duration_ms=excluded.duration_ms,
  cost_usd=excluded.cost_usd, cost_source=excluded.cost_source, raw=excluded.raw,
  ingested_at=datetime('now')
WHERE (usage_record.grain, usage_record.ts, usage_record.model, usage_record.model_norm,
       usage_record.project, usage_record.workspace, usage_record.sub_tool, usage_record.billing,
       usage_record.account, usage_record.iu_key, usage_record.machine, usage_record.outcome,
       usage_record.input_tokens, usage_record.output_tokens, usage_record.cache_read_tokens,
       usage_record.cache_write_tokens, usage_record.cache_write_1h_tokens,
       usage_record.reasoning_tokens, usage_record.duration_ms,
       usage_record.cost_usd, usage_record.cost_source, usage_record.raw)
  IS NOT
      (excluded.grain, excluded.ts, excluded.model, excluded.model_norm,
       excluded.project, excluded.workspace, excluded.sub_tool, excluded.billing,
       excluded.account, excluded.iu_key, excluded.machine, excluded.outcome,
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
      // A vendor-reported cost (the retired research-gateway's sonar rows, agent-gateway-iu's
      // gateway `usage.cost`) is authoritative — more accurate than this
      // table's pricing for a per-call vendor bill or a Bedrock/Azure-routed
      // model with no real cost field — and stored verbatim; everything else
      // is priced from tokens centrally.
      const cost =
        r.authoritativeCostUsd != null && !IGNORE_REPORTED_COST.has(modelNorm ?? "")
          ? { usd: r.authoritativeCostUsd, source: "reported" as const }
          : computeCost(modelNorm, {
              input: r.inputTokens,
              output: r.outputTokens,
              cacheRead: r.cacheReadTokens,
              cacheWrite: r.cacheWriteTokens,
              cacheWrite1h: r.cacheWrite1hTokens ?? 0,
              reasoning: r.reasoningTokens,
              grain: r.grain,
              ts: r.ts,
            });
      const sessionId = typeof r.raw?.sessionId === "string" ? r.raw.sessionId : undefined;
      const billing = classifyBilling(
        source,
        r.model,
        sessionId,
        typeof r.raw?.backend === "string" ? r.raw.backend : undefined,
      );
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
        $billing: billing,
        $account: resolveAccount({ billing, raw: r.raw }),
        $iu_key: resolveIuKey({ source, billing, raw: r.raw }),
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
