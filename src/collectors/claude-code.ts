import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  entrypointLane,
  getAgentGatewayLane,
  getSessionFactoryRole,
  getSessionFactorySession,
  getSessionLane,
  isBridgeRouted,
  SYNTHETIC_MODEL,
} from '../models.ts'
import { hasMirroredLogs, iumacMachineLabel, iumacProjectsDir, syncIumac } from '../remote.ts'
import type { SyncResult } from '../remote.ts'
import type {
  Collector,
  CollectContext,
  CollectResult,
  SessionEvent,
  UsageRecord,
} from '../types.ts'
import { walkJsonlFiles } from './fs-incremental.ts'

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
//
// Besides records the collector emits session events (usage.session_events): a `compact_boundary` system line is a
// compaction, a `Skill` tool call is a skill load and the `isMeta` user line after it (`sourceToolUseID` = the call's id)
// carries the loaded text, whose length is the skill's size. The two skill halves are separate events with the same id:
// they can land in different polls, the database merges them.

/**
 * This machine's own transcripts root. A function, not a frozen constant, so
 * tests can override it via USAGE_CLAUDE_PROJECTS_DIR without touching the
 * real ~/.claude/projects — same lazy-env pattern remote.ts already uses for
 * the iumac mirror root.
 */
function localProjectsDir(): string {
  return process.env.USAGE_CLAUDE_PROJECTS_DIR?.trim() || join(homedir(), '.claude', 'projects')
}

/** Every transcripts root that exists: this machine's, then the iumac mirror's. */
export function claudeCodeRoots(): string[] {
  return [localProjectsDir(), iumacProjectsDir()].filter((root) => existsSync(root))
}

/**
 * Test-only seam: lets claude-code.test.ts force syncIumac's outcome inside
 * collect() without an ssh/rsync call ever happening. Always null in
 * production; only setSyncOverrideForTest ever changes it.
 */
let syncOverrideForTest: (() => Promise<SyncResult>) | null = null

export function setSyncOverrideForTest(fn: (() => Promise<SyncResult>) | null): void {
  syncOverrideForTest = fn
}

interface AssistantLine {
  type?: string
  requestId?: string
  sessionId?: string
  uuid?: string
  parentUuid?: string
  timestamp?: string
  cwd?: string
  // "cli" (interactive), "sdk-cli" (`claude -p`, i.e. every agent-gateway worker) or
  // "claude-desktop"; on every transcript line.
  entrypoint?: string
  // The reasoning effort the request ran at (`low` ... `max`); `perTurnEffort` repeats it per turn and is the
  // fallback. Both sit at the top level of the assistant line, main transcript and subagent file alike.
  effort?: string
  perTurnEffort?: string
  // Subagent files (`<session>/subagents/agent-<id>.jsonl`, also under `subagents/workflows/`): every line is a
  // sidechain of the parent session, carries the parent's `sessionId`, its own `agentId` and, on most lines, the
  // agent type as `attributionAgent` (else the sibling `agent-<id>.meta.json` names it as `agentType`).
  isSidechain?: boolean
  agentId?: string
  attributionAgent?: string
  // Set on the local, non-API line a failed request synthesizes in place of a
  // real assistant response — see the isApiErrorMessage branch in parseLine.
  error?: string
  isApiErrorMessage?: boolean
  apiErrorStatus?: number
  // The `compact_boundary` system line: no usage, not an assistant line.
  subtype?: string
  compactMetadata?: {
    trigger?: string
    preTokens?: number
    postTokens?: number
    durationMs?: number
  }
  // The injected skill text: an `isMeta` user line whose `sourceToolUseID` is the Skill tool_use id.
  isMeta?: boolean
  sourceToolUseID?: string
  message?: {
    id?: string
    content?: unknown
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: {
        ephemeral_5m_input_tokens?: number
        ephemeral_1h_input_tokens?: number
      }
      // The provider's own thinking spend, billed at the output rate. Present
      // whenever the response used extended thinking; 0/absent otherwise —
      // see the module comment above parseLine for the verified evidence.
      output_tokens_details?: {
        thinking_tokens?: number
      }
      service_tier?: string
    }
  }
}

type Offsets = Record<string, number>

export const claudeCodeCollector: Collector = {
  source: 'claude-code',
  staleAfterHours: 48,

  available() {
    // Local-root semantics only, deliberately unchanged: the collector must
    // stay available even when the MacBook is asleep or unreachable — the
    // remote half degrades on its own inside collect(), never here.
    return existsSync(localProjectsDir())
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const offsets: Offsets = ctx.full ? {} : parseOffsets(ctx.cursor)
    const records: UsageRecord[] = []
    const events: SessionEvent[] = []

    // Refresh the mirror before reading it. Never lets a sync failure abort
    // local ingest.
    const sync = await (syncOverrideForTest ?? ctx.syncIumac ?? (() => syncIumac(ctx.log)))()
    if (!sync.ok) ctx.log.warn(`claude-code: ${sync.note}`)

    await collectRoot(localProjectsDir(), offsets, records, events, null, { advanceOffsets: true })

    // If the mirror doesn't exist at all (first run, or sync never succeeded
    // once), there's nothing to walk — skip it rather than treat a missing
    // root as an error.
    if (existsSync(iumacProjectsDir())) {
      const machine = await iumacMachineLabel()
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
      const advanceOffsets = sync.logsOk || hasMirroredLogs()
      await collectRoot(iumacProjectsDir(), offsets, records, events, machine, { advanceOffsets })
    }

    // Unconditional — not gated on records.length === 0. ingest.ts's runOne
    // only turns a note into `skipped` when records is *also* empty (see
    // ingest.ts:69), so surfacing a broken mirror here doesn't demote a
    // healthy local-only run to `skipped`; it just rides along as a note on
    // an otherwise `ok` status. Previously the note was swallowed the moment
    // any local record came in, which on this machine (which almost always
    // has local usage) meant a persistently broken mirror was silent forever.
    const note = sync.ok ? undefined : sync.note
    return { records, events, cursor: JSON.stringify(offsets), note }
  },
}

async function collectRoot(
  root: string,
  offsets: Offsets,
  records: UsageRecord[],
  events: SessionEvent[],
  machine: string | null,
  opts: { advanceOffsets: boolean },
): Promise<void> {
  const files = await walkJsonlFiles(root)
  for (const file of files) {
    const size = statSync(file).size
    const from = offsets[file] ?? 0
    if (size <= from) continue

    // Bytes, not characters: the offset is fed back to Bun.file().slice, and a line with multibyte text is longer in
    // bytes than in characters (a character index undershot and made every poll re-read part of what it had consumed).
    const chunk = new Uint8Array(await Bun.file(file).slice(from, size).arrayBuffer())
    const lastNl = chunk.lastIndexOf(0x0a)
    if (lastNl === -1) continue // no complete line yet; revisit next run

    const complete = new TextDecoder().decode(chunk.subarray(0, lastNl))
    const lines = complete.split('\n')
    // parentUuid chains a line to whatever causally preceded it (the user
    // message that triggered a turn, or — for a turn that streamed several
    // assistant lines — the previous one). That gap is the closest thing to a
    // per-request latency the transcript records, so it's built once per
    // chunk and used below for duration_ms. A parent from an earlier,
    // already-offset-consumed chunk (the first line after a resume) simply
    // isn't in the map, and that one record's duration falls back to null.
    const timestamps = buildTimestampMap(lines)
    const ctx: LineContext = { machine, timestamps, file }
    for (const line of lines) {
      const rec = parseLine(line, ctx)
      if (rec) records.push(rec)
      events.push(...parseEvents(line))
    }
    // Withheld only by the mirror root's bounded-re-read fallback above — the
    // local root always passes advanceOffsets: true.
    if (opts.advanceOffsets) offsets[file] = from + lastNl + 1
  }
}

/** What parseLine needs besides the line: the host, the chunk's uuid -> timestamp map, the file (for its meta sidecar). */
interface LineContext {
  machine: string | null
  timestamps: Map<string, string>
  file: string
  /** The sidecar's agent type, read once per file on first use (`null` = none). */
  metaType?: string | null
}

/** `agent-<id>.meta.json` next to a subagent file names its `agentType`. */
function metaAgentType(ctx: LineContext): string | null {
  if (ctx.metaType !== undefined) return ctx.metaType
  ctx.metaType = null
  try {
    const meta = JSON.parse(
      readFileSync(join(dirname(ctx.file), basename(ctx.file, '.jsonl') + '.meta.json'), 'utf8'),
    ) as {
      agentType?: unknown
    }
    if (typeof meta.agentType === 'string' && meta.agentType) ctx.metaType = meta.agentType
  } catch {
    // no sidecar (older Claude Code, or a workflow file): the caller falls back to "unknown"
  }
  return ctx.metaType
}

/**
 * The attribution every record of a Claude Code transcript carries in `raw`, read by the writer (never computed here):
 * the effort, the factory role and spawn key from the session's session_env line, and — for a subagent line — the
 * agent type, its id and the parent session. A subagent keeps the parent's `sessionId` here (session_env, billing and
 * account are looked up by it); `agentId` is what makes the writer give it a session of its own (`sessionKey`).
 */
function attribution(obj: AssistantLine, ctx: LineContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const effort = obj.effort ?? obj.perTurnEffort
  if (effort) out.effort = effort
  const role = getSessionFactoryRole(obj.sessionId)
  if (role) out.factoryRole = role
  const spawn = getSessionFactorySession(obj.sessionId)
  if (spawn) out.factorySession = spawn
  if (obj.isSidechain && obj.agentId && obj.sessionId) {
    out.subagentType = obj.attributionAgent || metaAgentType(ctx) || 'unknown'
    out.agentId = obj.agentId
    out.parentSessionId = obj.sessionId
  }
  return out
}

function buildTimestampMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    if (!line) continue
    try {
      const obj = JSON.parse(line) as { uuid?: string; timestamp?: string }
      if (obj.uuid && obj.timestamp) map.set(obj.uuid, obj.timestamp)
    } catch {
      continue
    }
  }
  return map
}

function computeDurationMs(obj: AssistantLine, timestamps: Map<string, string>): number | null {
  const parentTs = obj.parentUuid ? timestamps.get(obj.parentUuid) : undefined
  if (!parentTs || !obj.timestamp) return null
  const delta = Date.parse(obj.timestamp) - Date.parse(parentTs)
  return Number.isFinite(delta) && delta >= 0 ? delta : null
}

/** Stamp sub_tool, same rule for every record this file emits — never
 * overwriting a subTool already set. Precedence:
 *   1. the session's USAGE_LANE from its session_env line;
 *   2. agent-gateway's own time-window attribution log, only when there is NO
 *      session_env line at all (getSessionLane returns undefined) AND the
 *      entrypoint could be an agent-gateway worker (`sdk-cli`, or absent) — agent-gateway
 *      workers are always `claude -p`, so a `cli`/`claude-desktop` session that
 *      merely overlaps a window in time must never be stamped with it;
 *   3. the entrypoint lane (interactive / headless / desktop), null if unknown. */
function stampLane(
  record: UsageRecord,
  sessionId: string | undefined,
  entrypoint: string | undefined,
): void {
  if (record.subTool) return
  const lane = getSessionLane(sessionId)
  if (lane) {
    record.subTool = lane
    return
  }
  if (lane === undefined && (entrypoint === undefined || entrypoint === 'sdk-cli')) {
    const fallback = getAgentGatewayLane(record.ts, record.project)
    if (fallback) {
      record.subTool = fallback
      return
    }
  }
  record.subTool = entrypointLane(entrypoint)
}

function parseLine(line: string, ctx: LineContext): UsageRecord | null {
  const { machine, timestamps } = ctx
  if (!line) return null
  let obj: AssistantLine
  try {
    obj = JSON.parse(line) as AssistantLine
  } catch {
    return null
  }

  if (obj.type !== 'assistant') return null

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
    const sourceId = obj.requestId ?? obj.uuid
    if (!sourceId) return null

    const record: UsageRecord = {
      sourceId,
      grain: 'message',
      ts: obj.timestamp ?? new Date().toISOString(),
      model: obj.message?.model ?? null,
      project: obj.cwd ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      durationMs: computeDurationMs(obj, timestamps),
      outcome: 'error',
      machine,
      raw: {
        sessionId: obj.sessionId,
        error: obj.error ?? null,
        apiErrorStatus: obj.apiErrorStatus ?? null,
        entrypoint: obj.entrypoint ?? null,
        ...attribution(obj, ctx),
      },
    }
    stampLane(record, obj.sessionId, obj.entrypoint)
    return record
  }

  const usage = obj.message?.usage
  if (!usage) return null
  if (obj.message?.model === SYNTHETIC_MODEL) return null // local, non-API message

  const model = obj.message?.model ?? null
  // Every id counts — Max, `ca` and agent-gateway's `iu` lane all leave the
  // transcript as their only record. The one exception is the retired LiteLLM
  // bridge era, where the litellm source already holds the request (see
  // LITELLM_BRIDGE_CUTOFF); billing is classified centrally in db.ts.
  if (isBridgeRouted(model, obj.timestamp)) return null

  const sourceId = obj.requestId ?? obj.uuid ?? `${obj.sessionId}:${obj.message?.id}`
  if (!sourceId) return null

  const record: UsageRecord = {
    sourceId,
    grain: 'message',
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
      entrypoint: obj.entrypoint ?? null,
      ...attribution(obj, ctx),
    },
  }

  stampLane(record, obj.sessionId, obj.entrypoint)
  return record
}

// Cheap prefilters: a line is parsed again for events only when it can hold one.
const COMPACTION_MARK = '"compact_boundary"'
const SKILL_CALL_MARK = '"Skill"' // not '"name":"Skill"': that would depend on the JSON spacing
const SKILL_TEXT_MARK = 'Base directory for this skill'
// An event ts outside this range is garbage (Postgres also rejects year 0): the line is no event, the batch is never failed by it.
const EVENT_TS_MIN = Date.UTC(2000, 0, 1)
const EVENT_TS_MAX = Date.UTC(2200, 0, 1)

/** The text of a message's content: a bare string, or the text blocks concatenated. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as { type?: string; text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * The session events of one transcript line (usually none): a compaction boundary, a Skill tool call (name only, never
 * its `args`: free text) or the injected skill text (size only, keyed by the call's id). Only `Skill` tool calls count;
 * a skill the user invoked by slash command has no call to key on.
 */
function parseEvents(line: string): SessionEvent[] {
  if (!line) return []
  const compaction = line.includes(COMPACTION_MARK)
  const call = line.includes(SKILL_CALL_MARK)
  const text = line.includes(SKILL_TEXT_MARK)
  if (!compaction && !call && !text) return []
  let obj: AssistantLine
  try {
    obj = JSON.parse(line) as AssistantLine
  } catch {
    return []
  }
  // An unparseable ts would fail the whole batch in Postgres and pin the cursor: such a line is no event. The ts is
  // normalized through Date, so what reaches Postgres is always a valid ISO instant (a date like 02-30 rolls over, never fails).
  const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
  if (!obj.sessionId || !(at >= EVENT_TS_MIN && at <= EVENT_TS_MAX)) return []
  const base = {
    sessionId: obj.sessionId,
    agentId: obj.isSidechain && obj.agentId ? obj.agentId : undefined,
    ts: new Date(at).toISOString(),
  }

  if (compaction && obj.type === 'system' && obj.subtype === 'compact_boundary') {
    if (!obj.uuid) return []
    const m = obj.compactMetadata
    const detail: Record<string, unknown> = {}
    if (m?.trigger !== undefined) detail.trigger = m.trigger
    if (m?.preTokens !== undefined) detail.preTokens = m.preTokens
    if (m?.postTokens !== undefined) detail.postTokens = m.postTokens
    if (m?.durationMs !== undefined) detail.durationMs = m.durationMs
    return [{ ...base, eventId: obj.uuid, kind: 'compaction', detail }]
  }

  if (call && obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    const out: SessionEvent[] = []
    for (const block of obj.message.content as {
      type?: string
      id?: string
      name?: string
      input?: { skill?: unknown }
    }[]) {
      if (block?.type !== 'tool_use' || block.name !== 'Skill' || !block.id) continue
      const name =
        typeof block.input?.skill === 'string' && block.input.skill ? block.input.skill : undefined
      out.push({ ...base, eventId: block.id, kind: 'skill', name })
    }
    return out
  }

  if (text && obj.type === 'user' && obj.isMeta && obj.sourceToolUseID) {
    // The marker must open the message's own text: it can sit in any other field of an unrelated meta line.
    const body = messageText(obj.message?.content)
    if (!body.startsWith(SKILL_TEXT_MARK)) return []
    return [{ ...base, eventId: obj.sourceToolUseID, kind: 'skill', sizeChars: body.length }]
  }
  return []
}

function parseOffsets(cursor: string | null): Offsets {
  if (!cursor) return {}
  try {
    return JSON.parse(cursor) as Offsets
  } catch {
    return {}
  }
}
