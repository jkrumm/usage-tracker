import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// Reads offset-incrementally from a newline-delimited JSON file produced by the
// LiteLLM bridge. Each line is one request: { ts, ts_start, ts_end, duration_ms,
// request_id, model, input_tokens, output_tokens, cache_read_tokens,
// cache_write_tokens, reasoning_tokens }.
//
// Failed requests are logged too, marked `event: "error"` with no token fields.
// Kimi-K2.6 is single-backend (Azure Sweden) and intermittently 5xx/429s, so the
// error rate is a property of the bridge, not of any one consumer — every source
// routed through it (Hermes, sideclaw, …) sees the same rate. Capturing it once
// here as zero-token error rows makes that one rate queryable.
//
// Attribution: sideclaw appends one record per worker session to
// sideclaw-sessions.jsonl with { tool, project, tsStart, tsEnd }. For each
// litellm row whose ts falls inside one of those windows we tag the row with
// the sideclaw tool that caused it. The two logs share no key, so the join is
// time-window based; concurrent sessions are disambiguated by picking the
// narrowest window that contains the row.

const DEFAULT_PATH = join(homedir(), ".local", "share", "usage-tracker", "litellm.jsonl");
const SIDECLAW_SESSIONS_PATH = join(
  homedir(),
  ".local",
  "share",
  "usage-tracker",
  "sideclaw-sessions.jsonl",
);

interface LitellmLine {
  ts?: string;
  ts_start?: string | null;
  ts_end?: string | null;
  duration_ms?: number | null;
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

interface SideclawSession {
  tool: string;
  project: string | null;
  tsStartMs: number;
  tsEndMs: number;
  /** End - start in ms; used to pick the narrowest match when windows overlap. */
  spanMs: number;
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
      return { records: [], cursor: JSON.stringify({ offset }) };
    }

    const sessions = await loadSideclawSessions();

    const complete = chunk.slice(0, lastNl);
    const records: UsageRecord[] = [];

    for (const line of complete.split("\n")) {
      const rec = parseLine(line, sessions);
      if (rec) records.push(rec);
    }

    const newOffset = offset + lastNl + 1;
    return { records, cursor: JSON.stringify({ offset: newOffset }) };
  },
};

/**
 * Load the sideclaw session attribution log into memory. Sessions are short
 * (minutes) and the log file is small enough that re-reading on every collect
 * run is fine — collectors run every 15 min. If the file is missing we just
 * have no attribution this run; not an error.
 */
async function loadSideclawSessions(): Promise<SideclawSession[]> {
  const path = process.env.SIDECLAW_SESSIONS_LOG ?? SIDECLAW_SESSIONS_PATH;
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const sessions: SideclawSession[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsStart = typeof obj.tsStart === "string" ? Date.parse(obj.tsStart) : NaN;
    const tsEnd = typeof obj.tsEnd === "string" ? Date.parse(obj.tsEnd) : NaN;
    if (!Number.isFinite(tsStart) || !Number.isFinite(tsEnd)) continue;
    sessions.push({
      tool: typeof obj.tool === "string" ? obj.tool : "unknown",
      project: typeof obj.project === "string" ? obj.project : null,
      tsStartMs: tsStart,
      tsEndMs: tsEnd,
      spanMs: Math.max(0, tsEnd - tsStart),
    });
  }
  return sessions;
}

function matchSession(rowTs: string, sessions: SideclawSession[]): SideclawSession | undefined {
  const rowMs = Date.parse(rowTs);
  if (!Number.isFinite(rowMs)) return undefined;
  let best: SideclawSession | undefined;
  for (const s of sessions) {
    if (rowMs < s.tsStartMs || rowMs > s.tsEndMs) continue;
    if (!best || s.spanMs < best.spanMs) best = s;
  }
  return best;
}

function parseLine(line: string, sessions: SideclawSession[]): UsageRecord | null {
  if (!line) return null;
  let obj: LitellmLine;
  try {
    obj = JSON.parse(line) as LitellmLine;
  } catch {
    return null;
  }

  const sourceId = obj.request_id ?? String(Bun.hash(line));
  const ts = obj.ts ?? new Date().toISOString();
  const match = matchSession(ts, sessions);
  const durationMs = obj.duration_ms ?? null;

  if (obj.event === "error") {
    return {
      sourceId,
      grain: "message",
      ts,
      model: obj.model ?? null,
      project: match?.project ?? null,
      subTool: match?.tool ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      durationMs,
      outcome: "error",
      raw: {
        errorType: obj.error_type ?? null,
        errorCode: obj.error_code ?? null,
        statusCode: obj.status_code ?? null,
        tsStart: obj.ts_start ?? null,
        tsEnd: obj.ts_end ?? null,
      },
    };
  }

  const raw: Record<string, unknown> = {};
  if (obj.ts_start) raw.tsStart = obj.ts_start;
  if (obj.ts_end) raw.tsEnd = obj.ts_end;
  if (durationMs !== null) raw.durationMs = durationMs;

  return {
    sourceId,
    grain: "message",
    ts,
    model: obj.model ?? null,
    project: match?.project ?? null,
    subTool: match?.tool ?? null,
    inputTokens: obj.input_tokens ?? 0,
    outputTokens: obj.output_tokens ?? 0,
    cacheReadTokens: obj.cache_read_tokens ?? 0,
    cacheWriteTokens: obj.cache_write_tokens ?? 0,
    reasoningTokens: obj.reasoning_tokens ?? 0,
    durationMs,
    raw: Object.keys(raw).length > 0 ? raw : undefined,
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
