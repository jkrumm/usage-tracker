import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// Hermes and Feuer both run the NousResearch hermes-agent runtime, so they share
// the `sessions` table shape. The table is small (low thousands of rows) and
// rows mutate as a session progresses, so we re-read all of it each run and rely
// on the upsert to reconcile — no fragile watermark needed.
//
// Caveat (Feuer): its DB is bind-mounted into a running Docker container, so the
// host file is mid-WAL and reads as malformed. We open read-only and, on any
// failure, skip with a note rather than aborting the whole ingest. A consistent
// read needs a container-side export (see README → "Feuer access").

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

export function hermesAgentCollector(opts: { source: string; dbPath: string }): Collector {
  return {
    source: opts.source,

    available() {
      return existsSync(opts.dbPath);
    },

    async collect(_ctx: CollectContext): Promise<CollectResult> {
      let db: Database | undefined;
      try {
        db = new Database(opts.dbPath, { readonly: true });
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
        const records = rows.map((r) => toRecord(r));
        const cursor = String(Math.max(0, ...rows.map((r) => r.started_at)));
        return { records, cursor };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { records: [], cursor: _ctx.cursor, note: `unreadable: ${msg}` };
      } finally {
        db?.close();
      }
    },
  };
}

function toRecord(r: SessionRow): UsageRecord {
  return {
    sourceId: r.id,
    grain: "session",
    ts: new Date(r.started_at * 1000).toISOString(),
    model: r.model,
    project: r.source,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    reasoningTokens: r.reasoning_tokens ?? 0,
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
