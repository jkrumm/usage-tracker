import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { iumacCodexDir, iumacMachineLabel, syncIumac } from "../remote.ts";
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
// One collector, two roots: this machine's own ~/.codex/sessions, and a local
// rsync mirror of the MacBook's (ssh alias `iumac`, synced by remote.ts's
// third leg alongside claude-code's projects/logs — see iumacCodexDir()).
// Same shape as claude-code.ts's two-root walk: one shared cursor keyed by
// absolute path (mirrored files are just new keys, no format change), rows
// from the mirror tagged with the MacBook's machine label, local rows left
// unset so upsertRecords stamps the local host.

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
    // event_msg envelope — the sub-event kind lives on payload.type here,
    // distinct from the outer line's own `type`.
    type?: string;
    id?: string;
    message?: string;
  };
}

/**
 * Per-file watermark. The model lives on `turn_context` lines that may sit
 * before the offset a later run resumes from, so it is carried here rather
 * than re-read — otherwise every resumed session would report a null model and
 * price at nothing. `lastTs` is the previous line's timestamp regardless of
 * type, carried the same way so a response right after a resume still gets a
 * duration instead of silently reporting null forever.
 */
interface FileState {
  offset: number;
  model?: string | null;
  project?: string | null;
  lastTs?: string | null;
}

type Cursor = Record<string, FileState>;

export const codexCollector: Collector = {
  source: "codex",

  available() {
    // Local-root semantics only, deliberately unchanged (same reasoning as
    // claude-code.ts's available()): the collector must stay available even
    // when the MacBook is asleep or unreachable — the mirror degrades on its
    // own inside collect(), never here.
    return existsSync(sessionsDir());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const cursor: Cursor = ctx.full ? {} : parseCursor(ctx.cursor);
    const records: UsageRecord[] = [];

    // Refresh the mirror before reading it. Same call claude-code.ts makes at
    // the top of its own collect() — kept independent rather than shared so
    // `ingest --source codex` alone still refreshes the mirror instead of
    // silently reading stale (or absent) data; when both collectors run in
    // the same ingest cycle the second call is a cheap no-op rsync (nothing
    // changed since the first). Never throws; a failed codex leg only logs a
    // warning and local ingest continues (see SyncResult.codexOk in remote.ts
    // for why this never touches `note`/`ok`).
    const sync = await syncIumac(ctx.log);
    if (!sync.codexOk) ctx.log.warn("codex: iumac codex-sessions mirror sync failed");

    await collectRoot(sessionsDir(), cursor, records, null, ctx.log);

    // If the mirror doesn't exist at all (first run, or sync never succeeded
    // once), there's nothing to walk — skip it rather than treat a missing
    // root as an error.
    if (existsSync(iumacCodexDir())) {
      const machine = await iumacMachineLabel();
      await collectRoot(iumacCodexDir(), cursor, records, machine, ctx.log);
    }

    return { records, cursor: JSON.stringify(cursor) };
  },
};

/** Walk every rollout file under `root`, advancing the shared cursor in place. */
async function collectRoot(
  root: string,
  cursor: Cursor,
  records: UsageRecord[],
  machine: string | null,
  log: Logger,
): Promise<void> {
  for (const file of await walkJsonlFiles(root)) {
    const state = cursor[file] ?? { offset: 0 };
    const next = await collectFile(file, state, machine, log);
    cursor[file] = next.state;
    records.push(...next.records);
  }
}

/** One rollout file from its watermark forward. */
async function collectFile(
  file: string,
  state: FileState,
  machine: string | null,
  log: Logger,
): Promise<{ records: UsageRecord[]; state: FileState }> {
  const chunk = await readNewLines(file, state.offset, statSync(file).size);
  if (!chunk) return { records: [], state };

  const records: UsageRecord[] = [];
  let model = state.model ?? null;
  let project = state.project ?? null;
  let lastTs = state.lastTs ?? null;

  for (const line of chunk.lines) {
    const obj = parseLine(line);
    if (!obj) continue;

    // The gap to whatever line preceded this one, chronologically — the same
    // "time since the last causally-relevant event" idea claude-code.ts uses
    // via parentUuid, adapted to codex's flat, unlinked line stream. A parent
    // from an already-offset-consumed chunk (first line after a resume)
    // simply isn't carried forward past this run's FileState.lastTs, so that
    // one record's duration falls back to null.
    const prevTs = lastTs;
    if (obj.timestamp) lastTs = obj.timestamp;

    // A session can switch models mid-thread (`/model`, or `cx` then a
    // profile), so this tracks the latest rather than the first.
    if (obj.type === "session_meta" || obj.type === "turn_context") {
      model = obj.payload?.model ?? model;
      project = obj.payload?.cwd ?? project;
      continue;
    }

    if (obj.type === "event_msg") {
      const rec = toErrorRecord(obj, model, project, machine, prevTs);
      if (rec) records.push(rec);
      continue;
    }

    if (obj.type !== "token_usage_record") continue;

    const rec = toRecord(obj, model, project, machine, log, prevTs);
    if (rec) records.push(rec);
  }

  return { records, state: { offset: chunk.offset, model, project, lastTs } };
}

/**
 * Best-effort failed-turn detection. No confirmed real-world example of a
 * codex-rs error/turn-abort line was available while writing this (every
 * local rollout examined completed cleanly; retries surface only in the
 * separate `~/.codex/logs_*.sqlite` diagnostic log this collector is
 * deliberately barred from reading — see the module comment). This is
 * therefore a tolerant, generic match on any `event_msg` whose inner
 * `payload.type` names an error, rather than a specific string verified
 * against the vendor's actual schema — safe to ship because it can only ever
 * add rows, never suppress a legitimate token_usage_record.
 */
function toErrorRecord(
  obj: RolloutLine,
  model: string | null,
  project: string | null,
  machine: string | null,
  prevTs: string | null,
): UsageRecord | null {
  const kind = obj.payload?.type;
  if (!kind || !/error|fail|abort/i.test(kind)) return null;

  const sourceId = obj.payload?.id ?? obj.payload?.turn_id ?? `event:${Bun.hash(JSON.stringify(obj))}`;

  return {
    sourceId,
    grain: "message",
    ts: obj.timestamp ?? new Date().toISOString(),
    model,
    project,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: durationSince(prevTs, obj.timestamp),
    outcome: "error",
    machine,
    raw: {
      eventType: kind,
      message: obj.payload?.message ?? null,
      turnId: obj.payload?.turn_id ?? null,
    },
  };
}

function durationSince(prevTs: string | null, ts: string | undefined): number | null {
  if (!prevTs || !ts) return null;
  const delta = Date.parse(ts) - Date.parse(prevTs);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function toRecord(
  obj: RolloutLine,
  model: string | null,
  project: string | null,
  machine: string | null,
  log: Logger,
  prevTs: string | null,
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
    durationMs: durationSince(prevTs, obj.timestamp),
    machine,
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
