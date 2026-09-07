import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { iumacLogsDir } from "./remote.ts";
import type { Billing } from "./types.ts";

// claude-code's transcripts don't record which ANTHROPIC_BASE_URL produced a
// message, so `hooks/notify.ts` logs it once per SessionStart to the same
// structured log dir it already writes to. Loaded lazily and cached for the
// life of the process (ingest is a short-lived one-shot run).
let sessionBaseUrls: Map<string, string | null> | null = null;

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
 * loadSessionBaseUrls' inputs deterministically. Never called from
 * production code.
 */
export function resetSessionBaseUrlsCacheForTest(): void {
  sessionBaseUrls = null;
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

function loadSessionBaseUrls(): Map<string, string | null> {
  const map = new Map<string, string | null>();
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
              data?: { session?: string; base_url?: string | null };
            };
            if (entry.event === "session_env" && entry.data?.session) {
              map.set(entry.data.session, entry.data.base_url ?? null);
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
  if (!sessionBaseUrls) sessionBaseUrls = loadSessionBaseUrls();
  return sessionBaseUrls.get(sessionId);
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
 * When the log line is missing (pruned after 3 days, or the transcript is
 * older than the hook) the id decides the only way it can: Max serves nothing
 * but bare `claude-*` ids, so a non-Anthropic or `-eu` id is "iu" and a bare
 * Claude id defaults to "max" — precision isn't critical here, only not being
 * obviously wrong.
 */
export function classifyBilling(
  source: string,
  rawModel: string | null,
  sessionId?: string | null,
): Billing {
  if (source === "claude-code") {
    const baseUrl = getSessionBaseUrl(sessionId);
    if (baseUrl !== undefined) return baseUrl ? "iu" : "max";
    return isIuOnlyModel(rawModel) ? "iu" : "max";
  }

  // hermes / feuer / opencode / sideclaw-iu all bill per-token against the IU
  // unified endpoint.
  return "iu";
}
