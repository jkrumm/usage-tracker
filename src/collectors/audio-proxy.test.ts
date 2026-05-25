import { describe, expect, test } from "bun:test";
import { toRecord } from "./audio-proxy.ts";
import { computeCost } from "../pricing.ts";
import { normalizeModel } from "../models.ts";

describe("audio-proxy collector", () => {
  test("toRecord maps a fixture AudioProxyRow to correct UsageRecord", () => {
    const row = {
      id: 1,
      ts: "2026-05-25T08:00:00.000Z",
      endpoint: "speech",
      model: "gemini-3.1-flash-tts-preview",
      status: 200,
      input_tokens: 12,
      output_tokens: 3400,
      bytes_out: 50000,
    };
    const record = toRecord(row);
    expect(record.sourceId).toBe("audio-proxy:1");
    expect(record.grain).toBe("message");
    expect(record.model).toBe("gemini-3.1-flash-tts-preview");
    expect(record.inputTokens).toBe(12);
    expect(record.outputTokens).toBe(3400);
    expect(record.outcome).toBe("ok");
  });

  test("computeCost for gemini-3.1-flash-tts-preview output tokens", () => {
    const modelNorm = normalizeModel("gemini-3.1-flash-tts-preview");
    const result = computeCost(modelNorm, { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(result.usd).toBe(20);
  });
});
