import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// OpenCode (sst/opencode) keeps one row per session in a Drizzle-managed SQLite
// DB. The table is tiny and rows mutate during a session, so — like the
// hermes-agent collector — we re-read all and upsert. Timestamps are epoch ms;
// the model column is JSON ({"id":"…","providerID":"…"}) and is normalized
// downstream in models.ts.

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

interface SessionRow {
  id: string;
  directory: string | null;
  slug: string | null;
  title: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  time_created: number; // epoch ms
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

export const opencodeCollector: Collector = {
  source: "opencode",

  available() {
    return existsSync(DB_PATH);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    let db: Database | undefined;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const rows = db
        .query<SessionRow, []>(
          `SELECT id, directory, slug, title, agent, model, cost, time_created,
                  tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write
           FROM session`,
        )
        .all();
      const records = rows.map((r) => toRecord(r));
      const cursor = String(Math.max(0, ...rows.map((r) => r.time_created)));
      return { records, cursor };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
    } finally {
      db?.close();
    }
  },
};

function toRecord(r: SessionRow): UsageRecord {
  return {
    sourceId: r.id,
    grain: "session",
    ts: new Date(r.time_created).toISOString(),
    model: r.model,
    project: r.directory,
    inputTokens: r.tokens_input ?? 0,
    outputTokens: r.tokens_output ?? 0,
    cacheReadTokens: r.tokens_cache_read ?? 0,
    cacheWriteTokens: r.tokens_cache_write ?? 0,
    reasoningTokens: r.tokens_reasoning ?? 0,
    raw: {
      slug: r.slug,
      title: r.title,
      agent: r.agent,
      reportedCostUsd: r.cost,
    },
  };
}
