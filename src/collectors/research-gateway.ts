import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, Logger, Outcome, UsageRecord } from "../types.ts";

// Reads offset-incrementally from the NDJSON log research-gateway appends one
// line per usage record to — the argo usage record verbatim, in the same
// directory sideclaw's `sideclaw-iu.jsonl` lives in, so this mirrors
// sideclaw-iu.ts's offset handling (including its tolerance for a half-written
// trailing line, and recovering from a rotation/truncation instead of stalling).
//
// One line per record: { source, source_id, grain: "session", ts, model,
//   input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
//   duration_ms, cost_usd, cost_source, sub_tool, billing, project, workspace,
//   machine, outcome?, raw?, ingested_at? }.
//
// The line's own `billing:"iu"` and `machine:"mini"` are ignored: billing is
// derived centrally (models.ts classifyBilling) and machine is stamped by
// upsertRecords from machine.ts, exactly like every other local collector.
//
// Cost is the one field this collector decides per row:
//   - a row with a `model` (lead/worker LLM calls) is priced by the central
//     table — the line's own cost_usd is ignored;
//   - a `cost_source:"reported"` row (sonar, the vendor's own per-call cost)
//     keeps the line's cost_usd, marked authoritative;
//   - anything else (no model, `cost_source:"none"`) stays null.
// The authoritative path lives in db.upsertRecords.
//
// Upsert key is (source, source_id), so the same id may reappear later (the
// `tavily-account` snapshot is re-sent) — the last line wins, exactly like any
// other source's growing rows.

const DEFAULT_PATH = join(homedir(), ".local", "share", "usage-tracker", "research-gateway.jsonl");

interface ResearchGatewayLine {
  source_id?: string;
  ts?: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number | null;
  cost_usd?: number | null;
  cost_source?: string | null;
  sub_tool?: string | null;
  project?: string | null;
  outcome?: string | null;
  raw?: object | string | null;
}

interface Cursor {
  offset: number;
}

export const researchGatewayCollector: Collector = {
  source: "research-gateway",
  workspace: "private",

  available() {
    const path = process.env.RESEARCH_GATEWAY_USAGE_LOG ?? DEFAULT_PATH;
    return existsSync(path);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const path = process.env.RESEARCH_GATEWAY_USAGE_LOG ?? DEFAULT_PATH;
    if (!existsSync(path)) {
      return { records: [], cursor: ctx.cursor };
    }

    let { offset } = parseCursor(ctx);
    const size = statSync(path).size;
    if (size < offset) {
      // Rotated or truncated (logrotate's copytruncate, a fresh file replacing
      // this one): the offset is past EOF, so resume from the top rather than
      // stalling forever. Safe because upsert is idempotent on (source, source_id).
      offset = 0;
    }
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
  let obj: ResearchGatewayLine;
  try {
    obj = JSON.parse(line) as ResearchGatewayLine;
  } catch {
    // Half-written trailing line (append mid-tick) or a corrupt row.
    return null;
  }
  // source_id is the (source, source_id) dedup key — without it the row can't
  // be upserted safely. It means research-gateway is misbehaving, so say so
  // rather than dropping it silently.
  if (!obj.source_id) {
    log.warn(`research-gateway: dropping row with no source_id: ${line.slice(0, 120)}`);
    return null;
  }

  const raw: Record<string, unknown> = {};
  // `raw` is object|string upstream; nest it verbatim so either shape survives
  // (upsertRecords JSON.stringifies the whole record on the way to the column).
  if (obj.raw !== undefined && obj.raw !== null) raw.raw = obj.raw;
  // "timeout"/other non-ok outcomes collapse into the outcome column's "error";
  // keep the original string in raw so it isn't lost (same as sideclaw-sessions).
  if (obj.outcome && obj.outcome !== "ok" && obj.outcome !== "error") {
    raw.rawOutcome = obj.outcome;
  }

  return {
    sourceId: obj.source_id,
    grain: "session",
    ts: obj.ts ?? new Date().toISOString(),
    model: obj.model ?? null,
    project: obj.project ?? null,
    subTool: obj.sub_tool ?? null,
    inputTokens: num(obj.input_tokens),
    outputTokens: num(obj.output_tokens),
    cacheReadTokens: num(obj.cache_read_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: num(obj.reasoning_tokens),
    durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
    outcome: toOutcome(obj.outcome),
    // Only a vendor-reported cost overrides central pricing; a model row is
    // priced from its tokens, a no-model/no-cost row stays null.
    authoritativeCostUsd:
      obj.cost_source === "reported" &&
      typeof obj.cost_usd === "number" &&
      Number.isFinite(obj.cost_usd)
        ? obj.cost_usd
        : undefined,
    raw: Object.keys(raw).length > 0 ? raw : undefined,
  };
}

function toOutcome(outcome: string | null | undefined): Outcome {
  // Missing/unknown means "ok", matching UsageRecord.outcome's documented
  // default and every other collector.
  if (!outcome || outcome === "ok") return "ok";
  return "error";
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
