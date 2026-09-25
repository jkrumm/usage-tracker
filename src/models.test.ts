import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBilling,
  getSessionBaseUrl,
  getSessionLane,
  getSideclawLane,
  isBridgeRouted,
  LITELLM_BRIDGE_CUTOFF,
  normalizeModel,
  resetSessionBaseUrlsCacheForTest,
  resetSideclawWindowsCacheForTest,
} from "./models.ts";
import { PRICING } from "./pricing.ts";
import { iumacLogsDir } from "./remote.ts";

// normalizeModel is the join between a source's raw model string and the
// PRICING table: miss here and the record silently prices as unknown (usd:
// null) rather than failing loudly, so the spend just quietly vanishes from the
// ledger. These cases pin the shapes each collector actually emits.

describe("normalizeModel", () => {
  test("passes through an already-canonical id", () => {
    expect(normalizeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });

  test("is null-safe and trims", () => {
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel("")).toBeNull();
    expect(normalizeModel("  claude-sonnet-5  ")).toBe("claude-sonnet-5");
  });

  test("lowercases", () => {
    expect(normalizeModel("Kimi-K2.6")).toBe("kimi-k2.6");
  });

  test("unwraps OpenCode's JSON-encoded model", () => {
    expect(normalizeModel('{"id":"Kimi-K2.6","providerID":"iu"}')).toBe("kimi-k2.6");
  });

  test("falls back to the raw string on malformed JSON", () => {
    expect(normalizeModel('{"id":')).toBe('{"id":');
  });

  test("strips a provider prefix", () => {
    expect(normalizeModel("iu/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModel("MiniMaxAI/MiniMax-M3")).toBe("minimax-m3");
  });

  test("strips the IU gateway's -eu suffix (Hermes's live failover id)", () => {
    expect(normalizeModel("claude-sonnet-4-6-eu")).toBe("claude-sonnet-4-6");
  });

  test("strips Anthropic's compact dated variant", () => {
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("strips OpenAI's hyphenated dated variant", () => {
    // The shape the vendor reports back for a gpt-5.6-terra request. Before this
    // was handled it normalized to itself and priced as unknown.
    expect(normalizeModel("gpt-5.6-terra-2026-07-09")).toBe("gpt-5.6-terra");
    expect(normalizeModel("gpt-image-2-2026-04-21")).toBe("gpt-image-2");
    expect(normalizeModel("o4-mini-deep-research-2025-06-26")).toBe("o4-mini-deep-research");
  });

  test("does not mistake a version tail for a date", () => {
    // Real catalog ids whose trailing digits are versions, not dates — stripping
    // them would collapse distinct models onto one key.
    expect(normalizeModel("gpt-4-0613")).toBe("gpt-4-0613");
    expect(normalizeModel("mistral-large-2512")).toBe("mistral-large-2512");
    expect(normalizeModel("ministral-14b-2512")).toBe("ministral-14b-2512");
    expect(normalizeModel("gemini-2.5-flash-native-audio-preview-09-2025")).toBe(
      "gemini-2.5-flash-native-audio-preview-09-2025",
    );
  });

  test("combines prefix, -eu and date stripping", () => {
    expect(normalizeModel("iu/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  test("resolves the IU unified endpoint's Requesty-routed gateway ids onto their PRICING key", () => {
    // The gateway's casing is inconsistent (some ids ship title-cased, some
    // lower-case) — normalizeModel's plain lowercase must still land each one
    // on the exact PRICING key added for it.
    const gatewayIdToKey: Record<string, string> = {
      "glm-5.3-flash": "glm-5.3-flash",
      "glm-5.2": "glm-5.2",
      "GLM-5.1": "glm-5.1",
      hy3: "hy3",
      "kimi-k2.7-code": "kimi-k2.7-code",
      "minimax-m3": "minimax-m3",
      "MiMo-V2.5-Pro": "mimo-v2.5-pro",
      "nemotron-3-ultra": "nemotron-3-ultra",
      "NVIDIA-Nemotron-3-Super-120B-A12B": "nvidia-nemotron-3-super-120b-a12b",
      "qwen3.7-max": "qwen3.7-max",
      "DeepSeek-V4-Flash": "deepseek-v4-flash",
      "DeepSeek-V4-Pro": "deepseek-v4-pro",
      "DeepSeek-V4.1-Flash": "deepseek-v4.1-flash",
      "deepseek-v4.1-flash": "deepseek-v4.1-flash",
    };
    for (const [gatewayId, key] of Object.entries(gatewayIdToKey)) {
      expect(normalizeModel(gatewayId)).toBe(key);
      expect(PRICING[key]).toBeDefined();
    }
  });

  test("deepseek-v4.1-flash does not collapse onto the retired deepseek-v4-flash key", () => {
    // A new model, not a rename: the two must resolve to distinct PRICING
    // entries or historical v4-flash rows silently get re-priced at v4.1's rate.
    expect(normalizeModel("deepseek-v4.1-flash")).not.toBe(normalizeModel("deepseek-v4-flash"));
    expect(PRICING["deepseek-v4.1-flash"]).not.toEqual(PRICING["deepseek-v4-flash"]);
  });

  test("maps the bare deepseek-flash alias onto deepseek-v4-flash", () => {
    // Claude Code's own small/fast-model slot (ANTHROPIC_DEFAULT_HAIKU_MODEL,
    // pinned by sideclaw's session-runner.ts to "DeepSeek-V4-Flash") comes back
    // in the transcript as the bare, unversioned "deepseek-flash" — without this
    // mapping it priced at $0 for every row.
    expect(normalizeModel("deepseek-flash")).toBe("deepseek-v4-flash");
    expect(PRICING["deepseek-v4-flash"]).toBeDefined();
  });

  test("resolves the dated ids of priced models onto a real PRICING key", () => {
    // The regression that matters: a dated id must reach a rate, not price as null.
    for (const dated of [
      "gpt-5.6-terra-2026-07-09",
      "gpt-image-2-2026-04-21",
      "gpt-image-2.5-sunburst-2026-09-08",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6-eu",
    ]) {
      const key = normalizeModel(dated);
      expect(key).not.toBeNull();
      expect(PRICING[key as string]).toBeDefined();
    }
  });
});

// getSessionBaseUrl joins classifyBilling's sessionId lookup against
// session_env lines scanned from *two* dirs — this machine's own log dir and
// the iumac mirror — so a MacBook-only session still resolves. Both dirs are
// env-overridable for tests (USAGE_CLAUDE_LOGS_DIR, USAGE_REMOTE_DIR) so
// nothing here touches the real ~/.claude/logs.

describe("sessionLogDirs / loadSessionBaseUrls merge", () => {
  let localDir: string;
  let remoteDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-logs-"));
    remoteDir = mkdtempSync(join(tmpdir(), "usage-tracker-remote-"));
    process.env.USAGE_CLAUDE_LOGS_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = remoteDir;
    resetSessionBaseUrlsCacheForTest();
  });

  afterEach(() => {
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    rmSync(localDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
    resetSessionBaseUrlsCacheForTest();
  });

  test("scans and merges session_env lines from both the local and mirrored log dirs", () => {
    writeFileSync(
      join(localDir, "2026-08-06.jsonl"),
      `${JSON.stringify({ event: "session_env", data: { session: "local-session", base_url: null } })}\n`,
    );

    const mirrorLogsDir = iumacLogsDir();
    mkdirSync(mirrorLogsDir, { recursive: true });
    writeFileSync(
      join(mirrorLogsDir, "2026-08-06.jsonl"),
      `${JSON.stringify({
        event: "session_env",
        data: { session: "mirror-session", base_url: "https://iu-endpoint.example" },
      })}\n`,
    );

    expect(getSessionBaseUrl("local-session")).toBeNull();
    expect(getSessionBaseUrl("mirror-session")).toBe("https://iu-endpoint.example");
  });
});

// getSessionLane joins the same session_env line for sub_tool attribution
// (claude-code.ts applies it) — one scan, two derived facts.

describe("getSessionLane", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-logs-"));
    process.env.USAGE_CLAUDE_LOGS_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = join(localDir, "no-mirror");
    writeFileSync(
      join(localDir, "2026-09-10.jsonl"),
      [
        { event: "session_env", data: { session: "lane-session", base_url: null, lane: "sideclaw:review" } },
        { event: "session_env", data: { session: "no-lane-session", base_url: null } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    resetSessionBaseUrlsCacheForTest();
  });

  afterEach(() => {
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    rmSync(localDir, { recursive: true, force: true });
    resetSessionBaseUrlsCacheForTest();
  });

  test("returns the lane a spawner set via USAGE_LANE", () => {
    expect(getSessionLane("lane-session")).toBe("sideclaw:review");
  });

  test("returns null when the session_env line has no lane", () => {
    expect(getSessionLane("no-lane-session")).toBeNull();
  });

  test("returns undefined when no session_env line exists at all", () => {
    expect(getSessionLane("unknown-session")).toBeUndefined();
  });

  test("resetSessionBaseUrlsCacheForTest clears the shared cache so a new log dir is picked up", () => {
    expect(getSessionLane("lane-session")).toBe("sideclaw:review");

    rmSync(localDir, { recursive: true, force: true });
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-logs-"));
    process.env.USAGE_CLAUDE_LOGS_DIR = localDir;
    resetSessionBaseUrlsCacheForTest();

    expect(getSessionLane("lane-session")).toBeUndefined();
  });
});

// getSideclawLane is the fallback claude-code.ts's stampLane uses only when a
// session has no session_env line at all (see the doc comment on
// getSideclawLane in models.ts) — sideclaw's own session_env write has
// carried `lane` since 2026-09-24, so this fallback now only matters for a
// pruned or pre-fix line. It joins by time window instead, against sideclaw's
// independent attribution log.

describe("getSideclawLane", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-sideclaw-sessions-"));
    process.env.SIDECLAW_SESSIONS_LOG = join(dir, "sideclaw-sessions.jsonl");
    writeFileSync(
      process.env.SIDECLAW_SESSIONS_LOG,
      [
        {
          tool: "review:router",
          project: "/Users/jkrumm/SourceRoot/sideclaw",
          tsStart: "2026-09-24T18:22:19.444Z",
          tsEnd: "2026-09-24T18:22:35.797Z",
        },
        // A concurrent, wider window in a different project — picking the
        // narrowest match alone would pick this one over the true match below.
        {
          tool: "dispatch",
          project: "/Users/jkrumm/SourceRoot/warden",
          tsStart: "2026-09-24T18:20:00.000Z",
          tsEnd: "2026-09-24T18:30:00.000Z",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    resetSideclawWindowsCacheForTest();
  });

  afterEach(() => {
    delete process.env.SIDECLAW_SESSIONS_LOG;
    rmSync(dir, { recursive: true, force: true });
    resetSideclawWindowsCacheForTest();
  });

  test("coarsens the matched tool to sideclaw:<tool>, same as usageLane() would", () => {
    expect(getSideclawLane("2026-09-24T18:22:30.000Z", "/Users/jkrumm/SourceRoot/sideclaw")).toBe(
      "sideclaw:review",
    );
  });

  test("prefers the project-matching window over a wider one it's also inside", () => {
    // 18:22:30 falls inside BOTH windows above; the warden one is wider (and
    // would win a narrowest-span-only tie-break), but the project match wins.
    expect(getSideclawLane("2026-09-24T18:22:30.000Z", "/Users/jkrumm/SourceRoot/warden")).toBe(
      "sideclaw:dispatch",
    );
  });

  test("returns null outside every window", () => {
    expect(getSideclawLane("2026-09-24T19:00:00.000Z", "/Users/jkrumm/SourceRoot/sideclaw")).toBeNull();
  });

  test("returns null for a null/missing ts", () => {
    expect(getSideclawLane(null, "/Users/jkrumm/SourceRoot/sideclaw")).toBeNull();
  });
});

// The claude-code collector used to drop every non-`claude-*` row on the
// assumption that the LiteLLM bridge had counted it. The bridge is gone; the
// transcript is now the only record of a `ca glm-5.3-flash` session, so the
// id-shape guard is confined to the bridge era and billing comes from the
// session's real base_url.

describe("isBridgeRouted", () => {
  test("skips a bridge-shaped id only before the cutoff", () => {
    expect(isBridgeRouted("glm-5.3-flash", "2026-06-01T00:00:00Z")).toBe(true);
    expect(isBridgeRouted("claude-sonnet-4-6-eu", "2026-06-01T00:00:00Z")).toBe(true);
    expect(isBridgeRouted("claude-sonnet-5", "2026-06-01T00:00:00Z")).toBe(false);
    expect(isBridgeRouted("glm-5.3-flash", LITELLM_BRIDGE_CUTOFF)).toBe(false);
    expect(isBridgeRouted("glm-5.3-flash", "2026-09-01T03:40:37.841Z")).toBe(false);
    expect(isBridgeRouted("glm-5.3-flash", undefined)).toBe(false);
  });
});

describe("classifyBilling", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-logs-"));
    process.env.USAGE_CLAUDE_LOGS_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = join(localDir, "no-mirror");
    writeFileSync(
      join(localDir, "2026-09-07.jsonl"),
      [
        { event: "session_env", data: { session: "max-session", base_url: null } },
        { event: "session_env", data: { session: "iu-session", base_url: "https://iu-endpoint.example/anthropic" } },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    resetSessionBaseUrlsCacheForTest();
  });

  afterEach(() => {
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    rmSync(localDir, { recursive: true, force: true });
    resetSessionBaseUrlsCacheForTest();
  });

  test("claude-code follows the session's base_url regardless of model id", () => {
    expect(classifyBilling("claude-code", "claude-sonnet-5", "iu-session")).toBe("iu");
    expect(classifyBilling("claude-code", "glm-5.3-flash", "iu-session")).toBe("iu");
    expect(classifyBilling("claude-code", "claude-sonnet-5", "max-session")).toBe("max");
  });

  test("without a session_env line only a bare claude-* id can be Max", () => {
    expect(classifyBilling("claude-code", "claude-sonnet-5", "expired-session")).toBe("max");
    expect(classifyBilling("claude-code", "glm-5.3-flash", "expired-session")).toBe("iu");
    expect(classifyBilling("claude-code", "claude-sonnet-4-6-eu", "expired-session")).toBe("iu");
  });

  test("every other source bills iu", () => {
    expect(classifyBilling("hermes", "gpt-5.6-luna")).toBe("iu");
    expect(classifyBilling("sideclaw-iu", "gemini-3.5-flash")).toBe("iu");
  });

  test("sideclaw-sessions follows its own backend field, not the session log", () => {
    expect(classifyBilling("sideclaw-sessions", "claude-sonnet-5[1m]", null, "max")).toBe("max");
    expect(classifyBilling("sideclaw-sessions", "gemini-3.5-flash", null, "iu")).toBe("iu");
  });

  test("sideclaw-sessions without a backend falls back to the id heuristic", () => {
    expect(classifyBilling("sideclaw-sessions", "claude-sonnet-5", null, null)).toBe("max");
    expect(classifyBilling("sideclaw-sessions", "gemini-3.5-flash", null, null)).toBe("iu");
  });
});
