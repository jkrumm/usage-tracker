import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { codexCollector } from "./codex.ts";

// Covers the two things that would silently corrupt the bill: the OpenAI →
// additive token split (their cached/cache-write/reasoning counts are nested
// *inside* input_tokens/output_tokens, ours are additive), and the fact that a
// rollout carries running totals next to the per-response delta. It also pins
// the resume path, where the model lives on a turn_context line that sits
// before the offset the next run starts from.

const log: Logger = { info() {}, warn() {}, error() {} };

function sessionMeta(cwd: string): string {
  return `${JSON.stringify({
    timestamp: "2026-09-08T18:59:25.813Z",
    type: "session_meta",
    payload: { session_id: "sess-1", cwd, cli_version: "0.153.4" },
  })}\n`;
}

function turnContext(model: string): string {
  return `${JSON.stringify({
    timestamp: "2026-09-08T18:59:26.000Z",
    type: "turn_context",
    payload: { turn_id: "turn-1", model },
  })}\n`;
}

/** One response. `usage` is the delta; the *_token_usage blocks are cumulative. */
function tokenUsage(responseId: string, usage: Record<string, number>): string {
  const cumulative = Object.fromEntries(
    Object.entries(usage).map(([k, v]) => [k, v * 10]),
  );
  return `${JSON.stringify({
    timestamp: "2026-09-08T18:59:50.989Z",
    type: "token_usage_record",
    payload: {
      thread_id: "sess-1",
      turn_id: "turn-1",
      session_id: "sess-1",
      response_id: responseId,
      usage,
      turn_token_usage: cumulative,
      thread_token_usage: cumulative,
    },
  })}\n`;
}

describe("codex collector", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-codex-"));
    mkdirSync(join(dir, "2026", "09", "08"), { recursive: true });
    file = join(dir, "2026", "09", "08", "rollout-2026-09-08T18-59-25-sess-1.jsonl");
    process.env.USAGE_CODEX_SESSIONS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.USAGE_CODEX_SESSIONS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("splits OpenAI's nested counts into additive fields that sum to total_tokens", async () => {
    writeFileSync(
      file,
      sessionMeta("/Users/j/SourceRoot/x") +
        turnContext("gpt-6-astra") +
        tokenUsage("resp-1", {
          input_tokens: 12335,
          cached_input_tokens: 9576,
          cache_write_input_tokens: 2757,
          output_tokens: 147,
          reasoning_output_tokens: 8,
          total_tokens: 12482,
        }),
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sourceId).toBe("resp-1");
    expect(r.model).toBe("gpt-6-astra");
    expect(r.project).toBe("/Users/j/SourceRoot/x");
    // input_tokens is inclusive of both cache figures; output_tokens of reasoning.
    expect(r.inputTokens).toBe(2);
    expect(r.cacheReadTokens).toBe(9576);
    expect(r.cacheWriteTokens).toBe(2757);
    expect(r.outputTokens).toBe(139);
    expect(r.reasoningTokens).toBe(8);
    // The whole point: bill the vendor's total exactly once.
    const summed =
      r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens + r.reasoningTokens;
    expect(summed).toBe(12482);
  });

  test("ignores the cumulative turn/thread totals sitting beside the delta", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        tokenUsage("resp-1", { input_tokens: 100, output_tokens: 10, total_tokens: 110 }) +
        tokenUsage("resp-2", { input_tokens: 200, output_tokens: 20, total_tokens: 220 }),
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    expect(records.map((r) => r.inputTokens)).toEqual([100, 200]);
    expect(records.map((r) => r.outputTokens)).toEqual([10, 20]);
  });

  test("carries the model across a resumed offset", async () => {
    writeFileSync(
      file,
      turnContext("gpt-6-astra") +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
    );

    const first = await codexCollector.collect({ cursor: null, full: false, log });
    expect(first.records).toHaveLength(1);

    // A later response, with no turn_context line after the watermark.
    writeFileSync(
      file,
      turnContext("gpt-6-astra") +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }) +
        tokenUsage("resp-2", { input_tokens: 20, output_tokens: 2, total_tokens: 22 }),
    );

    const second = await codexCollector.collect({ cursor: first.cursor, full: false, log });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]!.sourceId).toBe("resp-2");
    expect(second.records[0]!.model).toBe("gpt-6-astra");
  });

  test("follows a mid-session model switch", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }) +
        turnContext("gpt-6-astra") +
        tokenUsage("resp-2", { input_tokens: 20, output_tokens: 2, total_tokens: 22 }),
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    expect(records.map((r) => r.model)).toEqual(["gpt-5.6-sol", "gpt-6-astra"]);
  });

  test("holds the offset on a half-written trailing line", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }).trimEnd(),
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    // turn_context is complete, the usage line has no newline yet — nothing billed.
    expect(records).toHaveLength(0);
  });
});

// Split from the block above rather than appended to it: the degenerate-input
// cases share no setup with the happy path, and one 150-line describe is
// harder to read than two focused ones.
describe("codex collector — malformed input", () => {
  let dir: string;
  let file: string;
  const warnings: string[] = [];
  const capturing: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };

  beforeEach(() => {
    warnings.length = 0;
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-codex-bad-"));
    mkdirSync(join(dir, "2026", "09", "08"), { recursive: true });
    file = join(dir, "2026", "09", "08", "rollout-bad.jsonl");
    process.env.USAGE_CODEX_SESSIONS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.USAGE_CODEX_SESSIONS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("warns instead of silently clamping when nested counts exceed their parent", async () => {
    writeFileSync(
      file,
      turnContext("gpt-6-astra") +
        tokenUsage("resp-1", {
          input_tokens: 100,
          cached_input_tokens: 90,
          cache_write_input_tokens: 50, // 90 + 50 > 100
          output_tokens: 10,
          reasoning_output_tokens: 40, // > output_tokens
          total_tokens: 110,
        }),
    );

    const { records } = await codexCollector.collect({
      cursor: null,
      full: false,
      log: capturing,
    });

    expect(records[0]!.inputTokens).toBe(0);
    expect(records[0]!.outputTokens).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resp-1");
  });

  test("drops a usage record with no response_id", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        `${JSON.stringify({
          timestamp: "2026-09-08T18:59:50.989Z",
          type: "token_usage_record",
          payload: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
        })}\n`,
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("a garbled line doesn't abort the rest of the file", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        "{not json at all\n" +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
    );

    const { records } = await codexCollector.collect({ cursor: null, full: false, log });

    expect(records.map((r) => r.sourceId)).toEqual(["resp-1"]);
  });

  test("a corrupted cursor falls back to a full re-read", async () => {
    writeFileSync(
      file,
      turnContext("gpt-5.6-sol") +
        tokenUsage("resp-1", { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
    );

    // Dedup on response_id absorbs the replay, so re-reading is safe.
    const { records } = await codexCollector.collect({ cursor: "{{not-json", full: false, log });

    expect(records.map((r) => r.sourceId)).toEqual(["resp-1"]);
  });
});
