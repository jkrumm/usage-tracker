import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, Logger, UsageRecord } from "../types.ts";
import { readNewLines, walkJsonlFiles } from "./fs-incremental.ts";

// The OpenAI Codex CLI (`cx` / `cxa` in dotfiles), pointed at the IU unified
// endpoint. Codex writes an append-only rollout JSONL per session under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl. Three line
// types matter:
//
//   session_meta        once, first line — session_id, cwd, cli_version
//   turn_context        per turn — the model actually used for that turn
//   token_usage_record  per API response — the usage delta we bill
//
// `token_usage_record` carries three token blocks: `usage` (this response),
// `turn_token_usage` and `thread_token_usage` (running totals). Only `usage` is
// read; summing the cumulative ones would multiply the bill by the turn count.
//
// sessions/ is bucketed by date (YYYY/MM/DD) and walked, not globbed at a
// fixed depth, so a bucketing change can't silently drop rows.
//
// The sqlite files next to sessions/ (state_*, thread_history_*, logs_*) are
// deliberately not read: thread_turns holds no token counts, and the rollout
// JSONL is both the authoritative record and the append-only shape every other
// collector here already handles.
//
// LOCAL ONLY. Unlike claude-code there is no iumac mirror, so codex runs on the
// MacBook are invisible until one is added — mirror the rsync in remote.ts if
// that ever matters.

const DEFAULT_DIR = join(homedir(), ".codex", "sessions");

function sessionsDir(): string {
  return process.env.USAGE_CODEX_SESSIONS_DIR?.trim() || DEFAULT_DIR;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    // session_meta
    session_id?: string;
    cwd?: string;
    cli_version?: string;
    // turn_context
    model?: string;
    // token_usage_record
    response_id?: string;
    turn_id?: string;
    usage?: CodexUsage;
  };
}

/**
 * Per-file watermark. The model lives on `turn_context` lines that may sit
 * before the offset a later run resumes from, so it is carried here rather
 * than re-read — otherwise every resumed session would report a null model and
 * price at nothing.
 */
interface FileState {
  offset: number;
  model?: string | null;
  project?: string | null;
}

type Cursor = Record<string, FileState>;

export const codexCollector: Collector = {
  source: "codex",

  available() {
    return existsSync(sessionsDir());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const root = sessionsDir();
    if (!existsSync(root)) return { records: [], cursor: ctx.cursor };

    const cursor: Cursor = ctx.full ? {} : parseCursor(ctx.cursor);
    const records: UsageRecord[] = [];

    for (const file of await walkJsonlFiles(root)) {
      const state = cursor[file] ?? { offset: 0 };
      const next = await collectFile(file, state, ctx.log);
      cursor[file] = next.state;
      records.push(...next.records);
    }

    return { records, cursor: JSON.stringify(cursor) };
  },
};

/** One rollout file from its watermark forward. */
async function collectFile(
  file: string,
  state: FileState,
  log: Logger,
): Promise<{ records: UsageRecord[]; state: FileState }> {
  const chunk = await readNewLines(file, state.offset, statSync(file).size);
  if (!chunk) return { records: [], state };

  const records: UsageRecord[] = [];
  let model = state.model ?? null;
  let project = state.project ?? null;

  for (const line of chunk.lines) {
    const obj = parseLine(line);
    if (!obj) continue;

    // A session can switch models mid-thread (`/model`, or `cx` then a
    // profile), so this tracks the latest rather than the first.
    if (obj.type === "session_meta" || obj.type === "turn_context") {
      model = obj.payload?.model ?? model;
      project = obj.payload?.cwd ?? project;
      continue;
    }
    if (obj.type !== "token_usage_record") continue;

    const rec = toRecord(obj, model, project, log);
    if (rec) records.push(rec);
  }

  return { records, state: { offset: chunk.offset, model, project } };
}

function toRecord(
  obj: RolloutLine,
  model: string | null,
  project: string | null,
  log: Logger,
): UsageRecord | null {
  const usage = obj.payload?.usage;
  // response_id is the dedup key; without it the row can't be upserted safely.
  const responseId = obj.payload?.response_id;
  if (!usage || !responseId) return null;

  const rawInput = usage.input_tokens ?? 0;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  const rawOutput = usage.output_tokens ?? 0;
  const reasoning = usage.reasoning_output_tokens ?? 0;

  // OpenAI reports cached and cache-write tokens as details *inside*
  // input_tokens, and reasoning tokens as a detail inside output_tokens — the
  // opposite of Anthropic, where they are additive. This table's contract is
  // the additive one (pricing.ts bills input + output + cacheRead + cacheWrite
  // + reasoning), so both are split back out here. The five fields then sum to
  // the vendor's own total_tokens, which is what keeps the spend landing once
  // instead of twice.
  //
  // A negative subtraction would mean that invariant has broken — a vendor
  // schema change, most likely. Clamping silently would make tokens disappear
  // from the bill with no signal at all, so say so.
  const input = rawInput - cacheRead - cacheWrite;
  const output = rawOutput - reasoning;
  if (input < 0 || output < 0) {
    log.warn(
      `codex: ${responseId} nested token counts exceed their parent ` +
        `(input ${rawInput}-${cacheRead}-${cacheWrite}, output ${rawOutput}-${reasoning}) — ` +
        `clamped, this row under-reports`,
    );
  }

  return {
    sourceId: responseId,
    grain: "message",
    ts: obj.timestamp ?? new Date().toISOString(),
    model,
    project,
    inputTokens: Math.max(0, input),
    outputTokens: Math.max(0, output),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    raw: {
      turnId: obj.payload?.turn_id ?? null,
      sessionId: obj.payload?.session_id ?? null,
      // The vendor's own arithmetic, kept so a future re-split can be checked
      // against it without re-reading the rollouts.
      vendorInputTokens: rawInput,
      vendorOutputTokens: rawOutput,
      totalTokens: usage.total_tokens ?? null,
    },
  };
}

function parseLine(line: string): RolloutLine | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as RolloutLine;
  } catch {
    return null;
  }
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor) as Cursor;
  } catch {
    return {};
  }
}
