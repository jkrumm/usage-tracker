import { existsSync } from "node:fs";
import type {
  Collector,
  CollectContext,
  CollectResult,
  UsageRecord,
  Workspace,
} from "../types.ts";

// Hermes and Feuer both run the NousResearch hermes-agent runtime, so they share
// the `sessions` table shape. The table is small (low thousands of rows) and
// rows mutate as a session progresses, so we re-read all of it each run and rely
// on the upsert to reconcile — no fragile watermark needed.

interface SessionRow {
  id: string;
  source: string | null;
  model: string | null;
  started_at: number; // unix seconds (REAL)
  ended_at: number | null;
  end_reason: string | null;
  message_count: number | null;
  tool_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  billing_provider: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  cost_status: string | null;
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

// Both daemons store the same `sessions` shape, but bun:sqlite can't open the
// DB: it lacks FTS5 and the schema carries a `messages_fts` virtual table, so a
// fresh bun connection fails with "unable to open database file". So we read out
// of process via a tool that *does* have FTS5 — the system `sqlite3` for the
// host bind-mount, or `python3` inside the container when FEUER_CONTAINER pins
// one. Both emit a JSON array of session rows that we map identically.
const SESSION_COLUMNS =
  "id, source, model, started_at, ended_at, end_reason, message_count, tool_call_count, " +
  "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, " +
  "billing_provider, estimated_cost_usd, actual_cost_usd, cost_status";

function collectFromContainer(
  container: string,
  ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  const sql = `SELECT ${SESSION_COLUMNS} FROM sessions`;
  const script =
    `import sqlite3, json; db = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True); ` +
    `db.row_factory = sqlite3.Row; rows = [dict(r) for r in db.execute(${JSON.stringify(sql)})]; ` +
    `print(json.dumps(rows))`;
  return runSessionQuery(["docker", "exec", container, "python3", "-c", script], ctx, project);
}

function collectFromHostFile(
  dbPath: string,
  ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  const sql = `SELECT ${SESSION_COLUMNS} FROM sessions`;
  return runSessionQuery(["sqlite3", "-json", `file:${dbPath}?mode=ro`, sql], ctx, project);
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

    const rows = (stdout ? JSON.parse(stdout) : []) as SessionRow[];
    if (!Array.isArray(rows)) {
      return { records: [], cursor: ctx.cursor, note: "unreadable: expected JSON array" };
    }

    const records = rows.map((r) => toRecord(r, project));
    const cursor = rows.length ? String(Math.max(0, ...rows.map((r) => r.started_at))) : ctx.cursor;
    return { records, cursor };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
  }
}

function toRecord(r: SessionRow, project: string): UsageRecord {
  const durationMs =
    r.ended_at != null && r.started_at != null
      ? Math.max(0, Math.round((r.ended_at - r.started_at) * 1000))
      : null;
  return {
    sourceId: r.id,
    grain: "session",
    ts: new Date(r.started_at * 1000).toISOString(),
    model: r.model,
    project,
    subTool: r.source,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    reasoningTokens: r.reasoning_tokens ?? 0,
    durationMs,
    raw: {
      endReason: r.end_reason,
      messageCount: r.message_count,
      toolCallCount: r.tool_call_count,
      billingProvider: r.billing_provider,
      costStatus: r.cost_status,
      reportedEstimatedCostUsd: r.estimated_cost_usd,
      reportedActualCostUsd: r.actual_cost_usd,
    },
  };
}
