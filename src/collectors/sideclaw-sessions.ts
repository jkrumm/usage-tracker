import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, Outcome, UsageRecord } from "../types.ts";

// Reads offset-incrementally from the NDJSON log sideclaw appends one line to
// per worker session (`check`/`review`/`dispatch`/… — every MCP tool tier),
// distinct from sideclaw-iu.ts's per-request multimodal log and from
// litellm.ts's use of this same file purely as a time-window join key for
// attributing *its* rows. This collector turns each session line into its own
// usage_record instead, which is the only place session-level outcome,
// duration and turn count become queryable — litellm.jsonl only ever sees the
// individual bridge requests a session made, not whether the session itself
// timed out or errored with no requests at all.
//
// One line per session: { sessionId, tool, project, model, backend, tsStart,
// tsEnd, outcome, durationMs, turns, exitCode, apiErrorStatus, reason }. No
// token counts are carried here — those are billed once already via litellm
// or claude-code/sideclaw-iu; this source exists purely for the operational
// fields those don't have. New fields have landed on this log over time
// (`backend`, `reason`, …), so every field below is read defensively rather
// than assumed present.
//
// `backend` ("max" | "iu") decides billing directly (see models.ts
// classifyBilling's sideclaw-sessions branch) rather than the id-based
// heuristic every other source falls back to — sideclaw dispatches both lanes
// under the same model ids, so the id alone can't tell them apart.

const DEFAULT_PATH = join(homedir(), ".local", "share", "usage-tracker", "sideclaw-sessions.jsonl");

interface SideclawSessionLine {
  sessionId?: string;
  tool?: string | null;
  project?: string | null;
  model?: string | null;
  backend?: string | null;
  tsStart?: string | null;
  tsEnd?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  turns?: number | null;
  exitCode?: number | null;
  apiErrorStatus?: number | null;
  reason?: string | null;
}

interface Cursor {
  offset: number;
}

export const sideclawSessionsCollector: Collector = {
  source: "sideclaw-sessions",

  available() {
    const path = process.env.SIDECLAW_SESSIONS_USAGE_LOG ?? DEFAULT_PATH;
    return existsSync(path);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const path = process.env.SIDECLAW_SESSIONS_USAGE_LOG ?? DEFAULT_PATH;
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
      const rec = parseLine(line);
      if (rec) records.push(rec);
    }

    const newOffset = offset + lastNl + 1;
    return { records, cursor: JSON.stringify({ offset: newOffset }) };
  },
};

function parseLine(line: string): UsageRecord | null {
  if (!line) return null;
  let obj: SideclawSessionLine;
  try {
    obj = JSON.parse(line) as SideclawSessionLine;
  } catch {
    // Half-written trailing line (LaunchAgent tick mid-append) or corrupt row.
    return null;
  }
  // Without a sessionId there is no dedup key, so the row can't be upserted
  // safely — drop it silently, same as a garbled line.
  if (!obj.sessionId) return null;

  const raw: Record<string, unknown> = {};
  if (typeof obj.backend === "string") raw.backend = obj.backend;
  if (typeof obj.reason === "string") raw.reason = obj.reason;
  if (typeof obj.exitCode === "number") raw.exitCode = obj.exitCode;
  if (typeof obj.apiErrorStatus === "number") raw.apiErrorStatus = obj.apiErrorStatus;
  if (typeof obj.turns === "number") raw.turns = obj.turns;
  // "timeout" collapses into the outcome column's "error" below; keep the
  // original three-way value so it's not lost.
  if (obj.outcome && obj.outcome !== "ok" && obj.outcome !== "error") raw.rawOutcome = obj.outcome;

  return {
    sourceId: obj.sessionId,
    grain: "session",
    ts: obj.tsStart ?? obj.tsEnd ?? new Date().toISOString(),
    model: obj.model ?? null,
    project: obj.project ?? null,
    subTool: obj.tool ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : null,
    outcome: toOutcome(obj.outcome),
    raw: Object.keys(raw).length > 0 ? raw : undefined,
  };
}

function toOutcome(outcome: string | null | undefined): Outcome {
  // Matches UsageRecord.outcome's own documented default: missing/unknown
  // means "ok", same as every other collector. "timeout" is the one observed
  // non-ok/non-error value today and collapses into "error" here (the
  // original string survives in raw.rawOutcome above).
  if (!outcome || outcome === "ok") return "ok";
  return "error";
}

function parseCursor(ctx: CollectContext): Cursor {
  if (!ctx.cursor) return { offset: 0 };
  try {
    return JSON.parse(ctx.cursor) as Cursor;
  } catch {
    return { offset: 0 };
  }
}
