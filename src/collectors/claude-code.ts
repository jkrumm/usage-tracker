import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionLane, isBridgeRouted } from "../models.ts";
import { hasMirroredLogs, iumacMachineLabel, iumacProjectsDir, syncIumac } from "../remote.ts";
import type { SyncResult } from "../remote.ts";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";
import { walkJsonlFiles } from "./fs-incremental.ts";

// Claude Code writes one JSONL file per session under ~/.claude/projects/.
// Files are append-only, so we resume each by byte offset (advancing only to the
// last complete line) and dedup on requestId. This is the only large source —
// ~370MB across hundreds of files — so incremental reads matter.
//
// One collector, two roots: this machine's ~/.claude/projects, and a local
// rsync mirror of the MacBook's (ssh alias `iumac`, synced by remote.ts).
// Still one `source = "claude-code"` — see remote.ts's module comment for why
// a second collector would collide on collector_state and isn't needed for
// the cursor either way. Rows from the mirror carry an explicit `machine`;
// local rows leave it unset so upsertRecords stamps the local host.

/**
 * This machine's own transcripts root. A function, not a frozen constant, so
 * tests can override it via USAGE_CLAUDE_PROJECTS_DIR without touching the
 * real ~/.claude/projects — same lazy-env pattern remote.ts already uses for
 * the iumac mirror root.
 */
function localProjectsDir(): string {
  return process.env.USAGE_CLAUDE_PROJECTS_DIR?.trim() || join(homedir(), ".claude", "projects");
}

/**
 * Test-only seam: lets claude-code.test.ts force syncIumac's outcome inside
 * collect() without an ssh/rsync call ever happening. Always null in
 * production; only setSyncOverrideForTest ever changes it.
 */
let syncOverrideForTest: (() => Promise<SyncResult>) | null = null;

export function setSyncOverrideForTest(fn: (() => Promise<SyncResult>) | null): void {
  syncOverrideForTest = fn;
}

interface AssistantLine {
  type?: string;
  requestId?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  cwd?: string;
  // Set on the local, non-API line a failed request synthesizes in place of a
  // real assistant response — see the isApiErrorMessage branch in parseLine.
  error?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      // The provider's own thinking spend, billed at the output rate. Present
      // whenever the response used extended thinking; 0/absent otherwise —
      // see the module comment above parseLine for the verified evidence.
      output_tokens_details?: {
        thinking_tokens?: number;
      };
      service_tier?: string;
    };
  };
}

type Offsets = Record<string, number>;

export const claudeCodeCollector: Collector = {
  source: "claude-code",

  available() {
    // Local-root semantics only, deliberately unchanged: the collector must
    // stay available even when the MacBook is asleep or unreachable — the
    // remote half degrades on its own inside collect(), never here.
    return existsSync(localProjectsDir());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const offsets: Offsets = ctx.full ? {} : parseOffsets(ctx.cursor);
    const records: UsageRecord[] = [];

    // Refresh the mirror before reading it. Never lets a sync failure abort
    // local ingest.
    const sync = await (syncOverrideForTest ? syncOverrideForTest() : syncIumac(ctx.log));
    if (!sync.ok) ctx.log.warn(`claude-code: ${sync.note}`);

    await collectRoot(localProjectsDir(), offsets, records, null, { advanceOffsets: true });

    // If the mirror doesn't exist at all (first run, or sync never succeeded
    // once), there's nothing to walk — skip it rather than treat a missing
    // root as an error.
    if (existsSync(iumacProjectsDir())) {
      const machine = await iumacMachineLabel();
      // Advance mirror offsets unless the logs leg failed *and* there's no
      // previously-mirrored logs data at all. A failed logs leg with existing
      // mirrored logs is at most one run (15 min) stale — good enough to
      // classify billing, so withholding the offset there would only cause
      // pointless re-reads next run. But a logs mirror that has never synced
      // anything means classification would default every one of these rows
      // to "max" forever the moment the offset moves past them — so in that
      // one case we still emit the records (visible immediately) but hold
      // the offset back. Because the upsert is keyed on (source, source_id),
      // the next successful sync simply overwrites the same rows with
      // corrected billing — the repo's reconcile-by-upsert property doing
      // the work instead of the collector having to be clever.
      const advanceOffsets = sync.logsOk || hasMirroredLogs();
      await collectRoot(iumacProjectsDir(), offsets, records, machine, { advanceOffsets });
    }

    // Unconditional — not gated on records.length === 0. ingest.ts's runOne
    // only turns a note into `skipped` when records is *also* empty (see
    // ingest.ts:69), so surfacing a broken mirror here doesn't demote a
    // healthy local-only run to `skipped`; it just rides along as a note on
    // an otherwise `ok` status. Previously the note was swallowed the moment
    // any local record came in, which on this machine (which almost always
    // has local usage) meant a persistently broken mirror was silent forever.
    const note = sync.ok ? undefined : sync.note;
    return { records, cursor: JSON.stringify(offsets), note };
  },
};

async function collectRoot(
  root: string,
  offsets: Offsets,
  records: UsageRecord[],
  machine: string | null,
  opts: { advanceOffsets: boolean },
): Promise<void> {
  const files = await walkJsonlFiles(root);
  for (const file of files) {
    const size = statSync(file).size;
    const from = offsets[file] ?? 0;
    if (size <= from) continue;

    const chunk = await Bun.file(file).slice(from, size).text();
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl === -1) continue; // no complete line yet; revisit next run

    const complete = chunk.slice(0, lastNl);
    const lines = complete.split("\n");
    // parentUuid chains a line to whatever causally preceded it (the user
    // message that triggered a turn, or — for a turn that streamed several
    // assistant lines — the previous one). That gap is the closest thing to a
    // per-request latency the transcript records, so it's built once per
    // chunk and used below for duration_ms. A parent from an earlier,
    // already-offset-consumed chunk (the first line after a resume) simply
    // isn't in the map, and that one record's duration falls back to null.
    const timestamps = buildTimestampMap(lines);
    for (const line of lines) {
      const rec = parseLine(line, machine, timestamps);
      if (rec) records.push(rec);
    }
    // Withheld only by the mirror root's bounded-re-read fallback above — the
    // local root always passes advanceOffsets: true.
    if (opts.advanceOffsets) offsets[file] = from + lastNl + 1;
  }
}

function buildTimestampMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { uuid?: string; timestamp?: string };
      if (obj.uuid && obj.timestamp) map.set(obj.uuid, obj.timestamp);
    } catch {
      continue;
    }
  }
  return map;
}

function computeDurationMs(obj: AssistantLine, timestamps: Map<string, string>): number | null {
  const parentTs = obj.parentUuid ? timestamps.get(obj.parentUuid) : undefined;
  if (!parentTs || !obj.timestamp) return null;
  const delta = Date.parse(obj.timestamp) - Date.parse(parentTs);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

/** Stamp sub_tool from the session's USAGE_LANE, same rule for every record
 * this file emits — never overwriting a subTool already set. */
function stampLane(record: UsageRecord, sessionId: string | undefined): void {
  if (record.subTool) return;
  const lane = getSessionLane(sessionId);
  if (lane) record.subTool = lane;
}

function parseLine(
  line: string,
  machine: string | null,
  timestamps: Map<string, string>,
): UsageRecord | null {
  if (!line) return null;
  let obj: AssistantLine;
  try {
    obj = JSON.parse(line) as AssistantLine;
  } catch {
    return null;
  }

  if (obj.type !== "assistant") return null;

  // The CLI synthesizes this line locally in place of a real API response
  // when a request fails outright (model_not_found, auth, rate_limit,
  // server_error, …) — `message.model` is always the literal string
  // "<synthetic>", never a billable id. Confirmed against real transcripts:
  //   { "type": "assistant", "message": { "model": "<synthetic>", "usage": {
  //     "input_tokens": 0, "output_tokens": 0, ... }, "content": [{ "type":
  //     "text", "text": "There's an issue with the selected model ..." }] },
  //     "error": "model_not_found", "isApiErrorMessage": true,
  //     "apiErrorStatus": 404, "uuid": "...", "sessionId": "..." }
  // requestId is present for 429/529 (rate_limit/server_error) but absent for
  // 401/403/404 (auth/model_not_found) — uuid is always present, so it's the
  // dedup key here rather than the triple fallback the success path uses.
  if (obj.isApiErrorMessage) {
    const sourceId = obj.requestId ?? obj.uuid;
    if (!sourceId) return null;

    const record: UsageRecord = {
      sourceId,
      grain: "message",
      ts: obj.timestamp ?? new Date().toISOString(),
      model: obj.message?.model ?? null,
      project: obj.cwd ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      durationMs: computeDurationMs(obj, timestamps),
      outcome: "error",
      machine,
      raw: {
        sessionId: obj.sessionId,
        error: obj.error ?? null,
        apiErrorStatus: obj.apiErrorStatus ?? null,
      },
    };
    stampLane(record, obj.sessionId);
    return record;
  }

  const usage = obj.message?.usage;
  if (!usage) return null;
  if (obj.message?.model === "<synthetic>") return null; // local, non-API message

  const model = obj.message?.model ?? null;
  // Every id counts — Max, `ca` and sideclaw's `iu` lane all leave the
  // transcript as their only record. The one exception is the retired LiteLLM
  // bridge era, where the litellm source already holds the request (see
  // LITELLM_BRIDGE_CUTOFF); billing is classified centrally in db.ts.
  if (isBridgeRouted(model, obj.timestamp)) return null;

  const sourceId = obj.requestId ?? obj.uuid ?? `${obj.sessionId}:${obj.message?.id}`;
  if (!sourceId) return null;

  const record: UsageRecord = {
    sourceId,
    grain: "message",
    ts: obj.timestamp ?? new Date().toISOString(),
    model: obj.message?.model ?? null,
    project: obj.cwd ?? null,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    // Provider-reported, not derived from the transcript's thinking-block
    // text — see the AssistantLine.message.usage.output_tokens_details field
    // comment and the evidence quoted above.
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    durationMs: computeDurationMs(obj, timestamps),
    machine,
    raw: {
      sessionId: obj.sessionId,
      messageId: obj.message?.id,
      serviceTier: usage.service_tier,
    },
  };

  stampLane(record, obj.sessionId);
  return record;
}

function parseOffsets(cursor: string | null): Offsets {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor) as Offsets;
  } catch {
    return {};
  }
}
