import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// Reads offset-incrementally from a newline-delimited JSON file produced by the
// LiteLLM bridge. Each line is one request: { ts, request_id, model, input_tokens,
// output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens }.
//
// Failed requests are logged too, marked `event: "error"` with no token fields.
// Kimi-K2.6 is single-backend (Azure Sweden) and intermittently 5xx/429s, so the
// error rate is a property of the bridge, not of any one consumer — every source
// routed through it (Hermes, sideclaw, …) sees the same rate. Capturing it once
// here as zero-token error rows makes that one rate queryable.

const DEFAULT_PATH = join(homedir(), ".local", "share", "usage-tracker", "litellm.jsonl");

interface LitellmLine {
  ts?: string;
  request_id?: string;
  model?: string | null;
  event?: string;
  error_type?: string | null;
  error_code?: string | number | null;
  status_code?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

interface Cursor {
  offset: number;
}

export const litellmCollector: Collector = {
  source: "litellm",

  available() {
    const path = process.env.LITELLM_USAGE_LOG ?? DEFAULT_PATH;
    return existsSync(path);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const path = process.env.LITELLM_USAGE_LOG ?? DEFAULT_PATH;
    if (!existsSync(path)) {
      return { records: [], cursor: ctx.cursor };
    }

    const { offset } = parseCursor(ctx);
    const size = statSync(path).size;
    if (size <= offset) {
      return { records: [], cursor: JSON.stringify({ offset }) };
    }

    const chunk = await Bun.file(path).slice(offset, size).text();
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl === -1) {
      // no complete line yet; revisit next run
      return { records: [], cursor: JSON.stringify({ offset }) };
    }

    const complete = chunk.slice(0, lastNl);
    const records: UsageRecord[] = [];

    for (const line of complete.split("\n")) {
      const rec = parseLine(line);
      if (rec) records.push(rec);
    }

    const newOffset = offset + lastNl + 1;
    return { records, cursor: JSON.stringify({ offset: newOffset }) };
  },
};

function parseLine(line: string): UsageRecord | null {
  if (!line) return null;
  let obj: LitellmLine;
  try {
    obj = JSON.parse(line) as LitellmLine;
  } catch {
    return null;
  }

  const sourceId = obj.request_id ?? String(Bun.hash(line));

  if (obj.event === "error") {
    return {
      sourceId,
      grain: "message",
      ts: obj.ts ?? new Date().toISOString(),
      model: obj.model ?? null,
      project: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outcome: "error",
      raw: {
        errorType: obj.error_type ?? null,
        errorCode: obj.error_code ?? null,
        statusCode: obj.status_code ?? null,
      },
    };
  }

  return {
    sourceId,
    grain: "message",
    ts: obj.ts ?? new Date().toISOString(),
    model: obj.model ?? null,
    project: null,
    inputTokens: obj.input_tokens ?? 0,
    outputTokens: obj.output_tokens ?? 0,
    cacheReadTokens: obj.cache_read_tokens ?? 0,
    cacheWriteTokens: obj.cache_write_tokens ?? 0,
    reasoningTokens: obj.reasoning_tokens ?? 0,
  };
}

function parseCursor(ctx: CollectContext): Cursor {
  if (!ctx.cursor) return { offset: 0 };
  try {
    return JSON.parse(ctx.cursor) as Cursor;
  } catch {
    return { offset: 0 };
  }
}
