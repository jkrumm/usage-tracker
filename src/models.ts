import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { iumacLogsDir } from "./remote.ts";
import type { Billing } from "./types.ts";

// claude-code's transcripts don't record which ANTHROPIC_BASE_URL produced a
// message, so `hooks/notify.ts` logs it once per SessionStart to the same
// structured log dir it already writes to. The same log line also carries
// `lane` — whoever spawned the session's `USAGE_LANE` env var, if any — so
// this one scan feeds both billing classification and sub_tool attribution.
// Loaded lazily and cached for the life of the process (ingest is a
// short-lived one-shot run).
interface SessionEnv {
  base_url: string | null;
  lane: string | null;
}
let sessionEnvs: Map<string, SessionEnv> | null = null;

/**
 * This machine's own session_env log dir. A function, not a frozen constant,
 * so tests can override it via USAGE_CLAUDE_LOGS_DIR without touching the
 * real ~/.claude/logs — same lazy-env pattern claude-code.ts uses for its
 * local transcripts root.
 */
function localSessionLogDir(): string {
  return process.env.USAGE_CLAUDE_LOGS_DIR?.trim() || join(homedir(), ".claude", "logs");
}

/**
 * Test-only: clear the module-level session_env cache so a test can control
 * loadSessionEnvs' inputs deterministically. Never called from production
 * code.
 */
export function resetSessionBaseUrlsCacheForTest(): void {
  sessionEnvs = null;
}

// iumac sessions never wrote into this machine's log dir, so a MacBook
// sessionId is absent unless its mirrored logs (synced by remote.ts) are also
// scanned here. Known limitation this doesn't fix: `hooks/notify.ts` prunes
// entries after 3 days, so a first backfill of iumac's *historical* sessions
// will still classify most of them "max" by default — those log lines are
// already gone on the source machine by the time the mirror first syncs them.
// Only going-forward classification is expected to be accurate.
function sessionLogDirs(): string[] {
  const dirs = [localSessionLogDir()];
  const mirror = iumacLogsDir();
  if (existsSync(mirror)) dirs.push(mirror);
  return dirs;
}

function loadSessionEnvs(): Map<string, SessionEnv> {
  const map = new Map<string, SessionEnv>();
  for (const dir of sessionLogDirs()) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        let text: string;
        try {
          text = readFileSync(join(dir, file), "utf-8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as {
              event?: string;
              data?: { session?: string; base_url?: string | null; lane?: string | null };
            };
            if (entry.event === "session_env" && entry.data?.session) {
              map.set(entry.data.session, {
                base_url: entry.data.base_url ?? null,
                lane: entry.data.lane ?? null,
              });
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // never fail classification on a log-dir read error
    }
  }
  return map;
}

export function getSessionBaseUrl(sessionId: string | null | undefined): string | null | undefined {
  if (!sessionId) return undefined;
  if (!sessionEnvs) sessionEnvs = loadSessionEnvs();
  return sessionEnvs.get(sessionId)?.base_url;
}

/**
 * The lane whoever spawned the session set via `USAGE_LANE` (`sideclaw:review`,
 * `wave`, `bg`, `warden`, …), joined the same way classifyBilling joins
 * base_url — by sessionId against the session_env log line. `undefined` means
 * no session_env line was found at all (pruned, or older than the hook);
 * `null` means the line exists but no lane was set for that session.
 */
export function getSessionLane(sessionId: string | null | undefined): string | null | undefined {
  if (!sessionId) return undefined;
  if (!sessionEnvs) sessionEnvs = loadSessionEnvs();
  return sessionEnvs.get(sessionId)?.lane;
}

// Fallback for the case getSessionLane can never solve. Until 2026-09-24,
// sideclaw's own writeSessionEnv() (needed because workers run with
// disableAllHooks, so the real SessionStart hook that carries `lane` never
// fires for them) wrote `{ session, base_url, model, backend }` with no `lane`
// field at all, so getSessionLane() resolved the *session id* fine (billing
// classified correctly) but always returned null for the lane, for every
// sideclaw row. sideclaw's writeSessionEnv now includes `lane` too, so a
// going-forward sideclaw session_env line resolves its lane directly and this
// fallback only matters for a session with no session_env line at all
// (pruned, or older than the fix) — stampLane (claude-code.ts) only calls it
// in that case, never when a line exists with a null lane.
//
// sideclaw independently writes `~/.local/share/usage-tracker/sideclaw-sessions.jsonl`,
// one record per worker with `{ tool, project, tsStart, tsEnd }` — but keyed by
// sideclaw's own pre-run UUID, not the transcript session id claude-code
// records, so there's no id to join on. litellm.ts solved the identical problem
// for bridge rows by matching a record's timestamp into a session's
// [tsStart, tsEnd] window instead; this does the same for claude-code rows,
// additionally preferring a window whose `project` matches the row's cwd to
// disambiguate concurrent sideclaw sessions (litellm rows carry no cwd, so
// litellm.ts can't do this) — ties fall back to the narrowest window.
interface SideclawWindow {
  tool: string;
  project: string | null;
  tsStartMs: number;
  tsEndMs: number;
  /** End - start in ms; used to pick the narrowest match when windows overlap. */
  spanMs: number;
}
let sideclawWindows: SideclawWindow[] | null = null;

function sideclawSessionsLogPath(): string {
  return (
    process.env.SIDECLAW_SESSIONS_LOG?.trim() ||
    join(homedir(), ".local", "share", "usage-tracker", "sideclaw-sessions.jsonl")
  );
}

/**
 * Test-only: clear the module-level sideclaw-sessions cache so a test can
 * control loadSideclawWindows' input deterministically. Never called from
 * production code.
 */
export function resetSideclawWindowsCacheForTest(): void {
  sideclawWindows = null;
}

function loadSideclawWindows(): SideclawWindow[] {
  const path = sideclawSessionsLogPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const windows: SideclawWindow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { tool?: string; project?: string; tsStart?: string; tsEnd?: string };
      const tsStartMs = typeof obj.tsStart === "string" ? Date.parse(obj.tsStart) : NaN;
      const tsEndMs = typeof obj.tsEnd === "string" ? Date.parse(obj.tsEnd) : NaN;
      if (!Number.isFinite(tsStartMs) || !Number.isFinite(tsEndMs)) continue;
      windows.push({
        tool: typeof obj.tool === "string" ? obj.tool : "unknown",
        project: typeof obj.project === "string" ? obj.project : null,
        tsStartMs,
        tsEndMs,
        spanMs: Math.max(0, tsEndMs - tsStartMs),
      });
    } catch {
      continue;
    }
  }
  return windows;
}

/**
 * Coarsened the same way sideclaw's usageLane() would (`sideclaw:<tool before
 * the first ':'>`) so `review:angle`/`review:synthesis`/… collapse onto one
 * `sideclaw:review` row, same as a correctly-written USAGE_LANE would have.
 * Returns null when no window contains `ts` — a manual `c`/`ca` session, or a
 * sideclaw window this log has already rotated past.
 */
export function getSideclawLane(ts: string | null | undefined, project: string | null | undefined): string | null {
  if (!ts) return null;
  const rowMs = Date.parse(ts);
  if (!Number.isFinite(rowMs)) return null;
  if (!sideclawWindows) sideclawWindows = loadSideclawWindows();

  let best: SideclawWindow | undefined;
  let bestIsProjectMatch = false;
  for (const w of sideclawWindows) {
    if (rowMs < w.tsStartMs || rowMs > w.tsEndMs) continue;
    const isProjectMatch = project != null && w.project === project;
    if (!best || (isProjectMatch && !bestIsProjectMatch) || (isProjectMatch === bestIsProjectMatch && w.spanMs < best.spanMs)) {
      best = w;
      bestIsProjectMatch = isProjectMatch;
    }
  }
  return best ? `sideclaw:${best.tool.split(":")[0]}` : null;
}

/**
 * Reduce a source's raw model string to a canonical key used for pricing and
 * grouping. Handles OpenCode's JSON-encoded model, the IU gateway's `-eu` suffix,
 * and provider prefixes like `iu/` or `anthropic/`.
 */
export function normalizeModel(raw: string | null): string | null {
  if (!raw) return null;
  let m = raw.trim();

  // OpenCode stores: {"id":"Kimi-K2.6","providerID":"iu"}
  if (m.startsWith("{")) {
    try {
      const parsed = JSON.parse(m) as { id?: string };
      if (parsed.id) m = parsed.id;
    } catch {
      // fall through with the raw string
    }
  }

  m = m.toLowerCase();
  if (m.includes("/")) m = m.split("/").pop() ?? m;
  // The IU gateway's EU-routed twin — same rate card as its parent. Still
  // live: Hermes fails over to `claude-sonnet-4-6-eu` under throttling.
  m = m.replace(/-eu$/, "");
  // Dated variant → bare alias. Both vendor conventions, since a source may
  // record either the id it requested or the dated id the vendor reports back:
  //   claude-haiku-4-5-20251001  (Anthropic, compact)
  //   gpt-5.6-terra-2026-07-09   (OpenAI, hyphenated)
  // Verified against the IU catalog's 287 ids: this collapses 44 dated variants
  // onto their bare alias and produces no unintended collisions.
  m = m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  // `deepseek-flash` (no version) is Claude Code's own small/fast-model slot
  // (ANTHROPIC_DEFAULT_HAIKU_MODEL), which sideclaw's session-runner.ts pins to
  // the literal id "DeepSeek-V4-Flash" for every non-Claude worker route — the
  // gateway then echoes a shorter alias back in the transcript's `message.model`
  // field instead of the requested id. Evidence: 1758+ claude-code rows since
  // 2026-09-12 whose project is a sideclaw worktree or `hermes`'s own
  // `compression` task (same alias, same gateway); one row's window lines up
  // exactly with a live `review:router` sideclaw-sessions.jsonl entry whose own
  // `model` field is "DeepSeek-V4-Flash". Without this it silently priced at
  // $0 (no PRICING entry for the bare alias).
  if (m === "deepseek-flash") m = "deepseek-v4-flash";
  return m;
}

/**
 * The local LiteLLM proxy's last real request. Until then a claude-code
 * session reaching a non-Anthropic id (DeepSeek, GLM, Kimi, …) or an `-eu`
 * EU-routed Claude id did so *through* the bridge, and the litellm source
 * counted that request per-call — so those transcript rows must stay skipped
 * or a `--full` backfill double-counts them. The proxy itself was deleted
 * 2026-09-04; its log holds one stray row after this date (a probe), nothing
 * a transcript could mirror.
 */
export const LITELLM_BRIDGE_CUTOFF = "2026-07-08T00:00:00Z";

/**
 * True only for the retired-bridge era: a bridge-shaped id (non-`claude-*`, or
 * `-eu`) with a timestamp before LITELLM_BRIDGE_CUTOFF. After the cutoff every
 * id reaches the API directly (the `ca` launcher and sideclaw's `iu` lane both
 * talk to the IU unified endpoint's native Anthropic route, Max serves the rest)
 * and the transcript is the only record of it, so nothing is skipped.
 */
export function isBridgeRouted(rawModel: string | null, ts: string | null | undefined): boolean {
  if (!ts || ts >= LITELLM_BRIDGE_CUTOFF) return false;
  return isIuOnlyModel(rawModel);
}

/**
 * An id the Max subscription can never serve: anything outside `claude-*`, or
 * the IU gateway's `-eu` EU-routed twin (Hermes still fails over to
 * `claude-sonnet-4-6-eu`, which is why normalizeModel keeps stripping it).
 */
function isIuOnlyModel(rawModel: string | null): boolean {
  const r = (rawModel ?? "").toLowerCase();
  return !r.startsWith("claude") || r.endsWith("-eu");
}

/**
 * Decide who actually pays for a record.
 *
 *   "max" — Max subscription (`c` launcher, api.anthropic.com)
 *   "iu"  — the IU unified endpoint, per-token: the `ca` launcher, sideclaw's
 *           `iu` lane (a `claude -p` session with ANTHROPIC_BASE_URL pointed
 *           at the endpoint's native Anthropic route, any served id), and every
 *           agent daemon.
 *
 * For claude-code the signal is the session's real `ANTHROPIC_BASE_URL`, never
 * the model id: `hooks/notify.ts` logs `{ event: "session_env", session,
 * base_url }` at SessionStart and `getSessionBaseUrl()` joins on `sessionId`.
 * That holds for subagents too — they inherit the parent's base URL, can run a
 * different model (`Explore` on Haiku inside a `ca` session) and share its
 * `sessionId` (no SessionStart of their own). A non-empty base_url is "iu", an
 * empty one "max".
 *
 * The same session_env line also carries `lane` — whoever spawned the session
 * set `USAGE_LANE` — joined via `getSessionLane()` and applied as `sub_tool` by
 * the claude-code collector, not this function. Subagents inherit it exactly
 * like they inherit base_url, sharing the parent's sessionId.
 *
 * When the log line is missing (pruned after 3 days, or the transcript is
 * older than the hook) the id decides the only way it can: Max serves nothing
 * but bare `claude-*` ids, so a non-Anthropic or `-eu` id is "iu" and a bare
 * Claude id defaults to "max" — precision isn't critical here, only not being
 * obviously wrong.
 *
 * The id check runs first and wins outright: Max can never serve a
 * non-Anthropic id, so a model only IU can serve (DeepSeek/GLM/Gemini/GPT/
 * MiniMax/…, or the `-eu` twin) is always "iu" even when the session_env line
 * reports an empty base_url — a stale/mis-joined line must not mislabel spend
 * that is provably not Max's to bill.
 */
export function classifyBilling(
  source: string,
  rawModel: string | null,
  sessionId?: string | null,
  backend?: string | null,
): Billing {
  if (source === "claude-code") {
    if (isIuOnlyModel(rawModel)) return "iu";
    const baseUrl = getSessionBaseUrl(sessionId);
    if (baseUrl !== undefined) return baseUrl ? "iu" : "max";
    return "max";
  }

  // sideclaw-sessions carries its own backend ("max" | "iu") straight from the
  // session log — sideclaw dispatches both lanes, so the model id alone can't
  // tell them apart. Older rows written before the field existed fall back to
  // the same id-based heuristic as the no-session_env case above.
  if (source === "sideclaw-sessions") {
    if (backend === "max" || backend === "iu") return backend;
    return isIuOnlyModel(rawModel) ? "iu" : "max";
  }

  // hermes / feuer / opencode / sideclaw-iu all bill per-token against the IU
  // unified endpoint.
  return "iu";
}
