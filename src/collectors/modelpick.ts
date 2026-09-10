import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// modelpick (~/SourceRoot/modelpick) benchmarks models against real APIs, but
// its harness points CLAUDE_CONFIG_DIR at a scratch dir it wipes after every
// run — no Claude Code transcript, so no other collector ever sees this spend
// (verified: $37.50 across 370 runs, 2026-08-31 → 2026-09-04, invisible until
// now). `bench_run` is the harness's own ledger, one row per (suite, model,
// task, attempt) it ran. One row is a full agent loop — potentially several
// turns — so grain is 'session', not 'message', same reasoning as hermes/feuer.
//
// `capability_probe`, a separate table in the same DB, is deliberately never
// read: it records latency_ms/accessible/probe_status/residency and no token
// columns at all, so its spend can't be reconstructed from the DB. Don't
// re-add it without a token source to back it.
//
// bench_run rows are append-only — a finished benchmark attempt never mutates
// — so unlike hermes/feuer/opencode's small mutable tables, this collector
// filters on a real `id` watermark (autoincrement, monotonic) instead of
// re-reading the whole table every run.
//
// Mini-only: this DB doesn't exist on other machines, so `available()` must
// fail closed rather than error when the file is absent.

function dbPath(): string {
  return (
    process.env.MODELPICK_DB?.trim() ||
    join(homedir(), "SourceRoot", "modelpick", "modelpick.db")
  );
}

interface BenchRunRow {
  id: number;
  suite_id: string;
  model_id: string;
  task_id: string;
  attempt: number;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  thinking_tokens: number | null;
  cost_usd: number | null;
  terminal_reason: string | null;
  created_at: string; // sqlite CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS", UTC
}

export const modelpickCollector: Collector = {
  source: "modelpick",
  workspace: "private",

  available() {
    return existsSync(dbPath());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const path = dbPath();
    if (!existsSync(path)) return { records: [], cursor: ctx.cursor };

    const since = ctx.full ? 0 : Number.parseInt(ctx.cursor ?? "0", 10) || 0;
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      const rows = db
        .query<BenchRunRow, [number]>(
          `SELECT id, suite_id, model_id, task_id, attempt, duration_ms,
                  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                  thinking_tokens, cost_usd, terminal_reason, created_at
           FROM bench_run
           WHERE id > ?
           ORDER BY id ASC`,
        )
        .all(since);

      const records = rows.map(toRecord);
      const cursor = rows.length
        ? String(Math.max(since, ...rows.map((r) => r.id)))
        : String(since);
      return { records, cursor };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
    } finally {
      db?.close();
    }
  },
};

function toRecord(r: BenchRunRow): UsageRecord {
  return {
    sourceId: String(r.id),
    grain: "session",
    ts: new Date(`${r.created_at.replace(" ", "T")}Z`).toISOString(),
    model: r.model_id,
    project: "modelpick",
    subTool: r.suite_id,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_creation_tokens ?? 0,
    reasoningTokens: r.thinking_tokens ?? 0,
    durationMs: r.duration_ms ?? null,
    raw: {
      taskId: r.task_id,
      attempt: r.attempt,
      terminalReason: r.terminal_reason,
      // The harness's own cost figure — kept for comparison only. pricing.ts
      // is this tracker's single source of truth for cost (collectors never
      // price, see its module comment), so bench_cost_usd never feeds
      // cost_usd; computeCost derives that from the token fields above like
      // every other source.
      bench_cost_usd: r.cost_usd,
    },
  };
}
