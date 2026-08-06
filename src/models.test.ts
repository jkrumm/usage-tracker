import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionBaseUrl, normalizeModel, resetSessionBaseUrlsCacheForTest } from "./models.ts";
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

  test("strips the bridge's -eu suffix", () => {
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

  test("resolves the dated ids of priced models onto a real PRICING key", () => {
    // The regression that matters: a dated id must reach a rate, not price as null.
    for (const dated of [
      "gpt-5.6-terra-2026-07-09",
      "gpt-image-2-2026-04-21",
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
