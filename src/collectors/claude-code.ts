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
  timestamp?: string;
  cwd?: string;
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
    for (const line of complete.split("\n")) {
      const rec = parseLine(line, machine);
      if (rec) records.push(rec);
    }
    // Withheld only by the mirror root's bounded-re-read fallback above — the
    // local root always passes advanceOffsets: true.
    if (opts.advanceOffsets) offsets[file] = from + lastNl + 1;
  }
}

function parseLine(line: string, machine: string | null): UsageRecord | null {
  if (!line) return null;
  let obj: AssistantLine;
  try {
    obj = JSON.parse(line) as AssistantLine;
  } catch {
    return null;
  }

  const usage = obj.message?.usage;
  if (obj.type !== "assistant" || !usage) return null;
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
    reasoningTokens: 0,
    machine,
    raw: {
      sessionId: obj.sessionId,
      messageId: obj.message?.id,
      serviceTier: usage.service_tier,
    },
  };

  // A session whose spawner set USAGE_LANE (sideclaw's Max-lane workers, `rd
  // wave`, `rd bg`, warden-caused work) gets its lane as sub_tool — never
  // overwriting a subTool this collector already set above (it sets none
  // today, but a future field wouldn't be clobbered here). Subagents share the
  // parent's sessionId and so inherit its lane too, same as billing above.
  if (!record.subTool) {
    const lane = getSessionLane(obj.sessionId);
    if (lane) record.subTool = lane;
  }

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
