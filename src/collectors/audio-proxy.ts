import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

const DB_PATH = process.env.AUDIO_PROXY_DB ?? join(homedir(), "SourceRoot", "audio-proxy", "data", "usage.db");

export interface AudioProxyRow {
  id: number;
  ts: string;
  endpoint: string | null;
  model: string | null;
  status: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_tokens: number | null;
  audio_seconds: number | null;
  input_chars: number | null;
  bytes_out: number | null;
}

export const audioProxyCollector: Collector = {
  source: "audio-proxy",

  available() {
    return existsSync(DB_PATH);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    let db: Database | undefined;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const rows = db
        .query<AudioProxyRow, []>(
          `SELECT id, ts, endpoint, model, status, latency_ms,
                  input_tokens, output_tokens, audio_tokens, audio_seconds,
                  input_chars, bytes_out
           FROM usage_record`,
        )
        .all();
      const records = rows.map((r) => toRecord(r));
      const cursor = String(Math.max(0, ...rows.map((r) => r.id)));
      return { records, cursor };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
    } finally {
      db?.close();
    }
  },
};

export function toRecord(r: AudioProxyRow): UsageRecord {
  return {
    sourceId: `audio-proxy:${r.id}`,
    grain: "message",
    ts: new Date(r.ts).toISOString(),
    model: r.model,
    project: null,
    subTool: r.endpoint,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: r.latency_ms,
    outcome: (r.status ?? 0) >= 400 ? "error" : "ok",
    raw: {
      endpoint: r.endpoint,
      status: r.status,
      audioTokens: r.audio_tokens,
      audioSeconds: r.audio_seconds,
      inputChars: r.input_chars,
      bytesOut: r.bytes_out,
    },
  };
}
