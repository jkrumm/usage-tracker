import { Database } from "bun:sqlite";
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

async function collectFromContainer(
  container: string,
  _ctx: CollectContext,
  project: string,
): Promise<CollectResult> {
  const script =
    'import sqlite3, json; db = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True); db.row_factory = sqlite3.Row; rows = [dict(r) for r in db.execute("SELECT id, source, model, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, estimated_cost_usd, actual_cost_usd, cost_status FROM sessions")]; print(json.dumps(rows))';

  try {
    const proc = Bun.spawn(["docker", "exec", container, "python3", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      // LaunchAgents (and worker subprocesses) inherit a minimal PATH; ensure the
      // docker binary is resolvable — OrbStack/Docker Desktop install to
      // /usr/local/bin, Homebrew to /opt/homebrew/bin.
      env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}` },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        records: [],
        cursor: _ctx.cursor,
        note: `unreadable: docker exec exited ${exitCode}${stderr ? ` — ${stderr.trim()}` : ""}`,
      };
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { records: [], cursor: _ctx.cursor, note: "unreadable: empty output" };
    }

    const rows = JSON.parse(trimmed) as SessionRow[];
    if (!Array.isArray(rows)) {
      return { records: [], cursor: _ctx.cursor, note: "unreadable: expected JSON array" };
    }

    const records = rows.map((r) => toRecord(r, project));
    const cursor = String(Math.max(0, ...rows.map((r) => r.started_at)));
    return { records, cursor };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { records: [], cursor: _ctx.cursor, note: `unreadable: ${msg}` };
  }
}

function collectFromHostFile(
  dbPath: string,
  _ctx: CollectContext,
  project: string,
): CollectResult {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<SessionRow, []>(
        `SELECT id, source, model, started_at, ended_at, end_reason,
                message_count, tool_call_count,
                input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens,
                billing_provider, estimated_cost_usd, actual_cost_usd, cost_status
         FROM sessions`,
      )
      .all();
    const records = rows.map((r) => toRecord(r, project));
    const cursor = String(Math.max(0, ...rows.map((r) => r.started_at)));
    return { records, cursor };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { records: [], cursor: _ctx.cursor, note: `unreadable: ${msg}` };
  } finally {
    db?.close();
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
