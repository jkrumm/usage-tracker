import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { sideclawIuCollector } from "./sideclaw-iu.ts";

// Pins the 2026-09-25 field additions: cache_read_tokens/cache_write_tokens
// split back out of input_tokens (OpenAI convention, same pattern codex.ts
// uses), cost_usd carried through as authoritativeCostUsd, and outcome.
// Backward compatibility with pre-addition rows (all four fields absent) is
// the other half of the contract.

const log: Logger = { info() {}, warn() {}, error() {} };

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("sideclaw-iu collector", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-sideclaw-iu-"));
    file = join(dir, "sideclaw-iu.jsonl");
    process.env.SIDECLAW_IU_USAGE_LOG = file;
  });

  afterEach(() => {
    delete process.env.SIDECLAW_IU_USAGE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  test("splits cache_read_tokens/cache_write_tokens out of input_tokens and carries a reported cost", async () => {
    writeFileSync(
      file,
      line({
        ts: "2026-09-25T06:46:00Z",
        request_id: "chatcmpl-1",
        tool: "review:adversary",
        model: "deepseek-v4.1-flash",
        input_tokens: 3634,
        output_tokens: 16,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 3650,
        cost_usd: 0.0011094,
        outcome: "ok",
        latency_ms: 5000,
        bytes: null,
      }),
    );

    const { records } = await sideclawIuCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.inputTokens).toBe(3634);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.outcome).toBe("ok");
    expect(r.authoritativeCostUsd).toBe(0.0011094);
  });

  test("input_tokens is inclusive of both cache fields (OpenAI convention)", async () => {
    writeFileSync(
      file,
      line({
        request_id: "chatcmpl-2",
        model: "deepseek-v4.1-flash",
        input_tokens: 3634, // 3456 cached + 178 uncached
        output_tokens: 20,
        cache_read_tokens: 3456,
        cache_write_tokens: 0,
        cost_usd: 0.000098136,
      }),
    );

    const { records } = await sideclawIuCollector.collect({ cursor: null, full: false, log });

    const r = records[0]!;
    expect(r.inputTokens).toBe(178);
    expect(r.cacheReadTokens).toBe(3456);
    expect(r.authoritativeCostUsd).toBe(0.000098136);
  });

  test("an error outcome is carried through", async () => {
    writeFileSync(
      file,
      line({ request_id: "chatcmpl-3", model: "gemini-3.5-flash", input_tokens: 10, output_tokens: 0, outcome: "error" }),
    );

    const { records } = await sideclawIuCollector.collect({ cursor: null, full: false, log });

    expect(records[0]?.outcome).toBe("error");
  });

  test("a pre-addition row (no cache/cost/outcome fields) defaults to 0/undefined/ok", async () => {
    writeFileSync(
      file,
      line({
        request_id: "chatcmpl-legacy",
        tool: "read_image",
        model: "gemini-3.5-flash",
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        latency_ms: 900,
        bytes: null,
      }),
    );

    const { records } = await sideclawIuCollector.collect({ cursor: null, full: false, log });

    const r = records[0]!;
    expect(r.inputTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.outcome).toBe("ok");
    expect(r.authoritativeCostUsd).toBeNull();
  });
});
