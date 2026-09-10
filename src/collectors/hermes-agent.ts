import { existsSync } from "node:fs";
import type {
  Collector,
  CollectContext,
  CollectResult,
  UsageRecord,
  Workspace,
} from "../types.ts";

// Hermes and Feuer both run the NousResearch hermes-agent runtime, so they share
// the same schema. We used to read the `sessions` table, which holds only the
// main-task tokens: a session that also ran background_review, title_generation,
// approval, vision or compression work leaves that spend off the books entirely
// (verified against a live state.db: `sessions` totalled 611.7M tokens across
// 2,671 rows vs. `session_model_usage`'s 693.9M across 4,324 rows — 82.2M tokens,
// 13.4%, all non-main-task work, gone). `sessions.model` is also a single
// column, so a session that used several models mid-run had all of its tokens
// misattributed to whichever one happened to be recorded there.
//
// `session_model_usage` fixes both: it's keyed by (session, model, task, billing
// tuple), so every model/task combination a session touched gets its own row.
// We join it back to `sessions` only for the fields it doesn't carry itself
// (session start/end time, the invocation channel, the end reason).

interface SessionModelUsageRow {
  session_id: string;
  model: string;
  task: string; // '' means the main agent loop
  smu_billing_provider: string | null;
  smu_billing_base_url: string | null;
  smu_billing_mode: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  smu_estimated_cost_usd: number | null;
  smu_actual_cost_usd: number | null;
  smu_cost_status: string | null;
  // joined from sessions
  session_source: string | null;
  started_at: number; // unix seconds (REAL)
  ended_at: number | null;
  end_reason: string | null;
  message_count: number | null;
  tool_call_count: number | null;
}

export function hermesAgentCollector(opts: {
  source: string;
  dbPath: string;
  container?: string;
  /** Workspace this collector emits — the daemon is pinned, not the records. */
  workspace: Workspace;
  /**
   * Repo this daemon lives in. The Hermes `session.source` column is an
   * invocation channel (`cron`/`cli`/…); we route that to `subTool` and pin
   * `project` to the repo so the dashboard's project breakdown shows
   * `hermes-agent` / `prometheus-feuer-agent` instead of `cron`.
   */
  project: string;
}): Collector {
  return {
    source: opts.source,
    workspace: opts.workspace,

    available() {
      if (opts.container) return true;
      return existsSync(opts.dbPath);
    },

    async collect(_ctx: CollectContext): Promise<CollectResult> {
      if (opts.container) {
        return collectFromContainer(opts.container, _ctx, opts.project);
      }
      return collectFromHostFile(opts.dbPath, _ctx, opts.project);
    },
  };
}

// Both daemons store the same schema, but bun:sqlite can't open the DB: it
// lacks FTS5 and the schema carries a `messages_fts` virtual table, so a fresh
// bun connection fails with "unable to open database file". So we read out of
// process via a tool that *does* have FTS5 — the system `sqlite3` for the host
// bind-mount, or `python3` inside the container when FEUER_CONTAINER pins one.
// Both emit a JSON array of joined rows that we map identically.
const SESSION_MODEL_USAGE_QUERY =
  "SELECT smu.session_id AS session_id, smu.model AS model, smu.task AS task, " +
  "smu.billing_provider AS smu_billing_provider, smu.billing_base_url AS smu_billing_base_url, " +
  "smu.billing_mode AS smu_billing_mode, smu.input_tokens AS input_tokens, " +
  "smu.output_tokens AS output_tokens, smu.cache_read_tokens AS cache_read_tokens, " +
  "smu.cache_write_tokens AS cache_write_tokens, smu.reasoning_tokens AS reasoning_tokens, " +
  "smu.estimated_cost_usd AS smu_estimated_cost_usd, smu.actual_cost_usd AS smu_actual_cost_usd, " +
  "smu.cost_status AS smu_cost_status, s.source AS session_source, s.started_at AS started_at, " +
  "s.ended_at AS ended_at, s.end_reason AS end_reason, s.message_count AS message_count, " +
  "s.tool_call_count AS tool_call_count " +
  "FROM session_model_usage smu JOIN sessions s ON s.id = smu.session_id";

// Feuer runs an OLDER build of the same runtime whose schema predates
// `session_model_usage` — verified 2026-09-10: its state.db has `sessions`
// only, so the query above fails with "no such table" and the collector
// reports `skipped`, silently collecting nothing. This is the pre-split
// shape: one row per session, `task` empty, every token/billing field taken
// from the session row itself. Aliases match SESSION_MODEL_USAGE_QUERY
// exactly, so toRecord() maps both identically and the composite sourceId
// still comes out unique (a legacy session contributes exactly one row).
const LEGACY_SESSIONS_QUERY =
  "SELECT s.id AS session_id, s.model AS model, '' AS task, " +
  "s.billing_provider AS smu_billing_provider, s.billing_base_url AS smu_billing_base_url, " +
  "s.billing_mode AS smu_billing_mode, s.input_tokens AS input_tokens, " +
  "s.output_tokens AS output_tokens, s.cache_read_tokens AS cache_read_tokens, " +
  "s.cache_write_tokens AS cache_write_tokens, s.reasoning_tokens AS reasoning_tokens, " +
  "s.estimated_cost_usd AS smu_estimated_cost_usd, s.actual_cost_usd AS smu_actual_cost_usd, " +
  "s.cost_status AS smu_cost_status, s.source AS session_source, s.started_at AS started_at, " +
  "s.ended_at AS ended_at, s.end_reason AS end_reason, s.message_count AS message_count, " +
  "s.tool_call_count AS tool_call_count " +
  "FROM sessions s";

/**
 * Run the per-model query, falling back to the legacy per-session shape when
 * the daemon is too old to have `session_model_usage`. Only the missing-table
 * failure retries — every other failure (locked DB, missing binary, bad JSON)
 * returns as-is, so a real problem still surfaces as `skipped` with its note
 * rather than being masked by a second attempt against the same broken DB.
 */
async function runWithLegacyFallback(
  argvFor: (sql: string) => string[],
  ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  const primary = await runSessionQuery(argvFor(SESSION_MODEL_USAGE_QUERY), ctx, project, false);
  if (!primary.note?.includes("session_model_usage")) return primary;
  return runSessionQuery(argvFor(LEGACY_SESSIONS_QUERY), ctx, project, true);
}

function collectFromContainer(
  container: string,
  ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  return runWithLegacyFallback(
    (sql) => [
      "docker",
      "exec",
      container,
      "python3",
      "-c",
      `import sqlite3, json; db = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True); ` +
        `db.row_factory = sqlite3.Row; rows = [dict(r) for r in db.execute(${JSON.stringify(sql)})]; ` +
        `print(json.dumps(rows))`,
    ],
    ctx,
    project,
  );
}

function collectFromHostFile(
  dbPath: string,
  ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  return runWithLegacyFallback(
    (sql) => ["sqlite3", "-json", `file:${dbPath}?mode=ro`, sql],
    ctx,
    project,
  );
}

/**
 * Run a subprocess that prints a JSON array of session rows, parse it, and map
 * to records. Fully isolated: any failure (missing binary, locked/mid-WAL DB,
 * malformed JSON) returns a `note` with zero records, so the run is recorded as
 * `skipped` and never aborts the other collectors. An empty result set (no
 * sessions yet) is a valid `ok` run, not an error.
 */
async function runSessionQuery(
  argv: string[],
  ctx: CollectContext,
  project: string,
  /** True for the pre-`session_model_usage` shape — see toRecord's sourceId. */
  legacy: boolean,
): Promise<CollectResult> {
  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      // LaunchAgents inherit a minimal PATH; ensure both sqlite3 (/usr/bin) and
      // docker (OrbStack/Docker Desktop → /usr/local/bin, Homebrew →
      // /opt/homebrew/bin) resolve regardless of the launch environment.
      env: { ...process.env, PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}` },
    });
    const exitCode = await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();

    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      return { records: [], cursor: ctx.cursor, note: `unreadable: exit ${exitCode}${stderr ? ` — ${stderr}` : ""}` };
    }

    const rows = (stdout ? JSON.parse(stdout) : []) as SessionModelUsageRow[];
    if (!Array.isArray(rows)) {
      return { records: [], cursor: ctx.cursor, note: "unreadable: expected JSON array" };
    }

    const records = rows.map((r) => toRecord(r, project, legacy));
    const cursor = rows.length ? String(Math.max(0, ...rows.map((r) => r.started_at))) : ctx.cursor;
    return { records, cursor };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
  }
}

function toRecord(r: SessionModelUsageRow, project: string, legacy: boolean): UsageRecord {
  const durationMs =
    r.ended_at != null && r.started_at != null
      ? Math.max(0, Math.round((r.ended_at - r.started_at) * 1000))
      : null;
  // Deliberate re-key: the old collector emitted one row per session, keyed on
  // the bare session id. A session can now fan out into several rows (one per
  // model/task it touched), so the id has to carry all three — a bare session
  // id is no longer unique. This invalidates every previously-ingested
  // bare-session-id row; both the local DB and Argo need those purged
  // separately (tracked outside this change, see the ingest brief).
  // Legacy (pre-`session_model_usage`) daemons keep the ORIGINAL bare session
  // id. A legacy session fans out to exactly one row, so the bare id is still
  // unique — and reusing it means the rows already in the local DB and Argo
  // upsert in place instead of duplicating. Feuer matters here: its state.db
  // now holds 52 sessions but 4,621 of its rows were ingested from a larger
  // earlier DB, so re-keying it would strand 4,569 unregenerable rows next to
  // 52 new ones. Only the per-model shape gets the composite key.
  const sourceId = legacy ? r.session_id : `${r.session_id}:${r.task || "main"}:${r.model}`;
  // subTool already carried the invocation channel (cron/cli/slack, from
  // sessions.source) before this change — the dashboard's only per-record
  // breakdown dimension besides project/model. `task` is a second, orthogonal
  // axis (background_review/title_generation/approval/vision/compression, ''
  // for the main agent loop), so rather than pick one and drop the other we
  // namespace them the same way sideclaw already does for its own internal
  // phases (`review:angle`, `review:synthesis`, …): channel alone for the main
  // loop (unchanged filtering for the common case), `channel:task` once a row
  // is a side task. This keeps cron/slack/cli distinguishable in every row.
  const subTool = r.task ? `${r.session_source ?? "session"}:${r.task}` : r.session_source;
  return {
    sourceId,
    grain: "session",
    ts: new Date(r.started_at * 1000).toISOString(),
    model: r.model,
    project,
    subTool,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    reasoningTokens: r.reasoning_tokens ?? 0,
    durationMs,
    raw: {
      task: r.task || null,
      endReason: r.end_reason,
      messageCount: r.message_count,
      toolCallCount: r.tool_call_count,
      billingProvider: r.smu_billing_provider || null,
      billingBaseUrl: r.smu_billing_base_url || null,
      billingMode: r.smu_billing_mode || null,
      costStatus: r.smu_cost_status,
      reportedEstimatedCostUsd: r.smu_estimated_cost_usd,
      reportedActualCostUsd: r.smu_actual_cost_usd,
    },
  };
}
