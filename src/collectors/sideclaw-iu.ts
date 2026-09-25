import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, Logger, Outcome, UsageRecord } from "../types.ts";

// Reads offset-incrementally from the NDJSON log sideclaw's `recordIuUsage`
// (server/lib/iu-openai.ts) appends to for its multimodal tools (`read_image`,
// `read_drawing`, `generate_image`) and the `review` adversary critic — plain
// `fetch` calls straight to the IU OpenAI transport that bypass both the
// LiteLLM bridge and the `claude -p` session path, so neither the litellm nor
// claude-code collector ever sees them. One line per request:
// { ts, source, request_id, tool, model, billing, input_tokens, output_tokens,
//   cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, outcome,
//   latency_ms, bytes }. `cache_read_tokens`/`cache_write_tokens`, `cost_usd`
//   and `outcome` were added 2026-09-25 — older rows lack them and are treated
//   as 0/null/"ok".
//
// The line's own `billing:"iu"` is ignored — billing is derived centrally
// (models.ts classifyBilling), not plumbed through from the source. `bytes` is
// image-output size in bytes for `generate_image` rows and null otherwise.
//
// `reasoning_tokens` is thinking spend, billed at the output rate. The IU
// gateway never reports it directly, so sideclaw derives it (total - input -
// output) in normalizeUsage and emits it here. Rows written before that field
// existed lack it and default to 0, understating those historical Gemini rows;
// their `total_tokens` survives in `raw.totalTokens` if they ever need fixing up.
//
// `input_tokens` is OpenAI-convention total prompt tokens, INCLUSIVE of both
// cache_read_tokens and cache_write_tokens — same nested-not-additive shape
// codex.ts already handles for Codex's `input_tokens`/`cached_input_tokens`/
// `cache_write_input_tokens`, so the two are split back out here the same way
// to keep this table's additive contract (input + output + cacheRead +
// cacheWrite + reasoning).
//
// `cost_usd`, when a number, is the gateway's own reported cost for the
// request — more accurate than this table's list-price proxy for the
// Bedrock/Azure-routed models sideclaw calls (gemini, gpt-image, gpt-5.6-*).
// It's carried through as `authoritativeCostUsd`; db.ts's upsertRecords uses
// it verbatim (cost_source = "reported") instead of computeCost, and
// reprice.ts never touches a "reported" row.

const DEFAULT_PATH = join(homedir(), ".local", "share", "usage-tracker", "sideclaw-iu.jsonl");

interface SideclawIuLine {
  ts?: string;
  request_id?: string;
  tool?: string | null;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number | null;
  outcome?: string | null;
  latency_ms?: number | null;
  bytes?: number | null;
}

interface Cursor {
  offset: number;
}

export const sideclawIuCollector: Collector = {
  source: "sideclaw-iu",

  available() {
    const path = process.env.SIDECLAW_IU_USAGE_LOG ?? DEFAULT_PATH;
    return existsSync(path);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const path = process.env.SIDECLAW_IU_USAGE_LOG ?? DEFAULT_PATH;
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
      // No complete line yet (mid-write); don't advance the offset.
      return { records: [], cursor: JSON.stringify({ offset }) };
    }

    const complete = chunk.slice(0, lastNl);
    const records: UsageRecord[] = [];

    for (const line of complete.split("\n")) {
      const rec = parseLine(line, ctx.log);
      if (rec) records.push(rec);
    }

    const newOffset = offset + lastNl + 1;
    return { records, cursor: JSON.stringify({ offset: newOffset }) };
  },
};

function parseLine(line: string, log: Logger): UsageRecord | null {
  if (!line) return null;
  let obj: SideclawIuLine;
  try {
    obj = JSON.parse(line) as SideclawIuLine;
  } catch {
    // Half-written trailing line (LaunchAgent tick mid-append) or corrupt row.
    return null;
  }
  // Without a request_id there is no dedup key, so the row can't be inserted
  // safely. This collector exists to catch spend nothing else sees, so say so
  // rather than dropping it silently — it means recordIuUsage is misbehaving.
  if (!obj.request_id) {
    log.warn(`sideclaw-iu: dropping row with no request_id: ${line.slice(0, 120)}`);
    return null;
  }

  const raw: Record<string, unknown> = {};
  if (typeof obj.total_tokens === "number") raw.totalTokens = obj.total_tokens;
  if (typeof obj.bytes === "number") raw.bytes = obj.bytes;

  // input_tokens is inclusive of both cache_read_tokens and cache_write_tokens
  // (OpenAI convention) — split back out to keep this table's additive
  // contract, same pattern as codex.ts's input_tokens/cached_input_tokens.
  const cacheRead = num(obj.cache_read_tokens);
  const cacheWrite = num(obj.cache_write_tokens);
  const input = Math.max(0, num(obj.input_tokens) - cacheRead - cacheWrite);

  const outcome: Outcome = obj.outcome === "error" ? "error" : "ok";

  return {
    sourceId: obj.request_id,
    grain: "message",
    ts: obj.ts ?? new Date().toISOString(),
    model: obj.model ?? null,
    project: null,
    subTool: obj.tool ?? null,
    inputTokens: input,
    outputTokens: num(obj.output_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: num(obj.reasoning_tokens),
    durationMs: typeof obj.latency_ms === "number" ? obj.latency_ms : null,
    outcome,
    authoritativeCostUsd: typeof obj.cost_usd === "number" ? obj.cost_usd : null,
    raw: Object.keys(raw).length > 0 ? raw : undefined,
  };
}

/** Token counts feed arithmetic and pricing — coerce anything non-numeric to 0
 * rather than letting a corrupt row write NaN into the ledger. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseCursor(ctx: CollectContext): Cursor {
  if (!ctx.cursor) return { offset: 0 };
  try {
    return JSON.parse(ctx.cursor) as Cursor;
  } catch {
    return { offset: 0 };
  }
}
