import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { iumacMachineLabel, iumacUsageJsonlDir, syncIumac } from "../remote.ts";
import type { Collector, CollectContext, CollectResult, Logger, UsageRecord } from "../types.ts";
import { readNewLines, walkJsonlFiles } from "./fs-incremental.ts";

// `astra` (dotfiles' `astra.sh`) is a one-shot OpenAI Responses call —
// gpt-6-astra, reasoning.mode=pro, effort xhigh — the highest per-call cost in
// the estate. It isn't a Codex session (no rollout JSONL) and isn't routed
// through sideclaw's IU transport either, so nothing else in this tracker ever
// sees it. astra.sh appends one JSON object per call to
// ~/.local/share/usage-tracker/astra.jsonl:
// { ts, request_id, model, input_tokens, output_tokens, reasoning_tokens,
//   cached_tokens, effort, mode, outcome, duration_ms }.
//
// input_tokens vs. cached_tokens: this is the same Responses-shaped usage
// object codex.ts already handles, where OpenAI reports cached tokens as a
// detail *inside* input_tokens (cached_input_tokens there). Consistent with
// that, input_tokens here is treated as inclusive of cached_tokens and the
// cached amount is subtracted back out so the additive contract
// (input + output + cacheRead + cacheWrite + reasoning) still holds. Unlike
// codex, reasoning_tokens is NOT treated as nested inside output_tokens: the
// example payload in the ingest brief has reasoning_tokens (890) exceed
// output_tokens (567), which is only possible if the two are already
// additive — astra.sh's own log format, not a raw vendor response, so it
// isn't bound to the vendor's nesting convention the way codex's rollout is.
//
// The user runs `astra` on both the mini and the MacBook, so — like
// claude-code.ts and codex.ts — this is one collector walking two roots: this
// machine's own ~/.local/share/usage-tracker, and a local rsync mirror of the
// MacBook's (ssh alias `iumac`, synced by remote.ts's fourth leg). Cursor is
// the same per-absolute-path offset map codex.ts/claude-code.ts use (not a
// single `{"offset": N}`, which can't express two files); mirror rows are
// tagged with the MacBook's machine label the same way, local rows left
// unset so upsertRecords stamps the local host. Both roots are walked with
// walkJsonlFiles and filtered to the `astra.jsonl` basename, since the mirror
// dir also holds other one-shot jsonl logs (e.g. sideclaw-iu.jsonl) this
// collector must not swallow.

const FILENAME = "astra.jsonl";

const DEFAULT_LOCAL_DIR = join(homedir(), ".local", "share", "usage-tracker");

function localDir(): string {
  return process.env.USAGE_ASTRA_DIR?.trim() || DEFAULT_LOCAL_DIR;
}

interface AstraLine {
  ts?: string;
  request_id?: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  effort?: string | null;
  mode?: string | null;
  outcome?: string | null;
  duration_ms?: number | null;
}

interface FileState {
  offset: number;
}

type Cursor = Record<string, FileState>;

export const astraCollector: Collector = {
  source: "astra",
  workspace: "private",

  available() {
    // Local-root semantics only, deliberately unchanged (same reasoning as
    // claude-code.ts / codex.ts's available()): stay available even when the
    // MacBook is asleep or unreachable — the mirror degrades on its own
    // inside collect(), never here.
    return existsSync(join(localDir(), FILENAME));
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const cursor: Cursor = ctx.full ? {} : parseCursor(ctx.cursor);
    const records: UsageRecord[] = [];

    // Refresh the mirror before reading it. Same call codex.ts/claude-code.ts
    // make at the top of their own collect() — kept independent rather than
    // shared so `ingest --source astra` alone still refreshes the mirror
    // instead of silently reading stale (or absent) data; when several
    // collectors run in the same ingest cycle the extra rsync calls are cheap
    // no-ops (nothing changed since the first one ran).
    const sync = await syncIumac(ctx.log);
    if (!sync.usageJsonlOk) ctx.log.warn("astra: iumac usage-jsonl mirror sync failed");

    const mirrorDir = iumacUsageJsonlDir();
    // Guard against DEFAULT_LOCAL_DIR being an *ancestor* of the mirror root
    // (both default to living under ~/.local/share/usage-tracker) — without
    // this, walking the local root would also recurse into the mirrored
    // astra.jsonl under mirrorDir, race the dedicated mirror walk below for
    // its cursor entry, and stamp that row as local instead of the
    // MacBook's. A USAGE_REMOTE_DIR pointed elsewhere never hits this.
    await collectRoot(localDir(), cursor, records, null, ctx.log, mirrorDir);

    // If the mirror doesn't exist at all (first run, or sync never succeeded
    // once), there's nothing to walk — skip it rather than treat a missing
    // root as an error.
    if (existsSync(mirrorDir)) {
      const machine = await iumacMachineLabel();
      await collectRoot(mirrorDir, cursor, records, machine, ctx.log);
    }

    return { records, cursor: JSON.stringify(cursor) };
  },
};

/** Walk every astra.jsonl under `root`, advancing the shared cursor in place. */
async function collectRoot(
  root: string,
  cursor: Cursor,
  records: UsageRecord[],
  machine: string | null,
  log: Logger,
  skipPrefix?: string,
): Promise<void> {
  for (const file of await walkJsonlFiles(root)) {
    if (basename(file) !== FILENAME) continue;
    if (skipPrefix && file.startsWith(skipPrefix)) continue;

    const state = cursor[file] ?? { offset: 0 };
    const size = statSync(file).size;
    const chunk = await readNewLines(file, state.offset, size);
    if (!chunk) continue;

    for (const line of chunk.lines) {
      const rec = parseLine(line, machine, log);
      if (rec) records.push(rec);
    }
    cursor[file] = { offset: chunk.offset };
  }
}

function parseLine(line: string, machine: string | null, log: Logger): UsageRecord | null {
  if (!line) return null;
  let obj: AstraLine;
  try {
    obj = JSON.parse(line) as AstraLine;
  } catch {
    return null;
  }
  if (!obj.request_id) {
    log.warn(`astra: dropping row with no request_id: ${line.slice(0, 120)}`);
    return null;
  }

  const cacheRead = num(obj.cached_tokens);
  const rawInput = num(obj.input_tokens);
  const input = Math.max(0, rawInput - cacheRead);
  if (rawInput - cacheRead < 0) {
    log.warn(`astra: ${obj.request_id} cached_tokens exceeds input_tokens — clamped`);
  }

  return {
    sourceId: obj.request_id,
    grain: "message",
    ts: obj.ts ?? new Date().toISOString(),
    model: obj.model ?? null,
    project: "astra",
    subTool: obj.mode ?? null,
    inputTokens: input,
    outputTokens: num(obj.output_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    reasoningTokens: num(obj.reasoning_tokens),
    durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
    outcome: obj.outcome === "error" ? "error" : "ok",
    machine,
    raw: {
      effort: obj.effort ?? null,
      outcome: obj.outcome ?? null,
    },
  };
}

/** Token counts feed arithmetic and pricing — coerce anything non-numeric to 0
 * rather than letting a corrupt row write NaN into the ledger. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  // Migrate the pre-two-root cursor shape ({"offset": N}), from when this
  // collector was a single-file offset walker cloned from sideclaw-iu.ts.
  // Treat that N as the local astra.jsonl file's starting offset so the
  // upgrade doesn't re-read its whole history — rows dedup on request_id
  // either way, but that's a pointless full re-read to avoid in three lines.
  const legacyOffset = (parsed as { offset?: unknown }).offset;
  if (typeof legacyOffset === "number") {
    return { [join(localDir(), FILENAME)]: { offset: legacyOffset } };
  }

  return parsed as Cursor;
}
