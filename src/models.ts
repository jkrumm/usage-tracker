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
 * grouping. Handles OpenCode's JSON-encoded model, the bridge's `-eu` suffix,
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
  m = m.replace(/-eu$/, ""); // bridge EU suffix
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
 * True when a raw claude-code model reached the API through the IU LiteLLM
 * bridge rather than a direct connection — the litellm source already counts
 * these per-request, so the claude-code collector must skip them to avoid
 * double-counting.
 */
export function isBridgeRouted(rawModel: string | null): boolean {
  const r = (rawModel ?? "").toLowerCase();
  return !r.startsWith("claude") || r.endsWith("-eu");
}

/**
 * Decide who actually pays for a record. Classification runs on the *raw* model
 * (before normalization) because the bridge's `-eu` suffix is the only signal
 * separating an IU-routed EU Claude worker from a Max-subscription Claude call.
 *
 *   "max" — Max subscription (c launcher, api.anthropic.com)
 *   "iu"  — IU LiteLLM bridge (sideclaw workers, claude_bridge) — skip in
 *           claude-code collector (litellm source already counted it) — OR
 *           the IU Anthropic endpoint, direct (ca launcher), no bridge
 *           involved — KEEP in claude-code collector. Both are real IU spend;
 *           the routing difference is an internal dedup signal (`isBridgeRouted`),
 *           not a billing distinction.
 *
 * A bare `claude-*` model (no `-eu` suffix) can come from either `c` (Max) or
 * `ca` (IU-direct) — the model name alone doesn't distinguish them, and that's
 * true for every model, not just the top-level one: a subagent inherits its
 * parent session's `ANTHROPIC_BASE_URL` and can run a different model (e.g.
 * `Explore` on Haiku inside a `ca` session), sharing that session's `sessionId`
 * (subagents don't get their own SessionStart). `sessionId` resolves it against
 * the `session_env` log line `hooks/notify.ts` writes at SessionStart (the real
 * `ANTHROPIC_BASE_URL` signal). Missing/expired log entries default to "max" —
 * precision isn't critical here, only not being obviously wrong.
 */
export function classifyBilling(
  source: string,
  rawModel: string | null,
  sessionId?: string | null,
): Billing {
  if (source === "claude-code") {
    if (isBridgeRouted(rawModel)) return "iu";
    return getSessionBaseUrl(sessionId) ? "iu" : "max";
  }

  // hermes / feuer / opencode all route through the IU LiteLLM bridge.
  return "iu";
}
