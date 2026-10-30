import { describe, expect, test } from "bun:test";
import { canonDecimal, droppedRate, normalizeLiteLLM, normalizeOpenRouter, perMillion, scheduleText, shiftDecimal } from "./normalize.ts";

describe("decimal shift", () => {
  test("is exact where doubles drift", () => {
    expect(1e-7 * 1e6).not.toBe(0.1);
    expect(perMillion(1e-7)).toBe("0.1");
    expect(perMillion(0.0000025)).toBe("2.5");
    expect(perMillion(1.25e-7)).toBe("0.125");
    expect(perMillion(0.00001)).toBe("10");
    expect(perMillion(6e-9)).toBe("0.006");
    expect(perMillion(0.00000132)).toBe("1.32");
    expect(shiftDecimal(3.5e-7, 6)).toBe("0.35");
  });

  test("absent, zero and negative prices are null", () => {
    expect(perMillion(undefined)).toBeNull();
    expect(perMillion(0)).toBeNull();
    expect(perMillion(-1e-6)).toBeNull();
    expect(perMillion("0.000001")).toBe("1");
  });

  test("canonDecimal", () => {
    expect(canonDecimal("2.500000")).toBe("2.5");
    expect(canonDecimal("10.000")).toBe("10");
    expect(canonDecimal("0.0100")).toBe("0.01");
  });
});

describe("normalizeLiteLLM", () => {
  test("flat Anthropic entry", () => {
    const s = normalizeLiteLLM({
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 1e-7,
      cache_creation_input_token_cost: 0.0000025,
      cache_creation_input_token_cost_above_1hr: 0.000004,
      input_cost_per_token_batches: 0.000001,
    });
    expect(s?.rates).toEqual({ input: "2", output: "10", cache_read: "0.1", cache_write_5m: "2.5", cache_write_1h: "4" });
    expect(s?.batch).toEqual({ input: "1" });
    expect(s?.tiers).toBeNull();
    expect(s?.offPeak).toBeNull();
  });

  test("context tiers, off-peak windows and zero cache writes", () => {
    const s = normalizeLiteLLM({
      input_cost_per_token: 1e-7,
      output_cost_per_token: 5e-7,
      input_cost_per_token_above_100k_tokens: 5e-7,
      cache_creation_input_token_cost_above_1hr_above_100k_tokens: 0.000001,
      input_cost_per_token_above_100k_tokens_batches: 2.5e-7,
      cache_creation_input_token_cost_above_12hr_above_272k_tokens: 0.00001,
      cache_creation_input_token_cost: 0,
      off_peak_pricing: {
        input_cost_per_token: 5e-8,
        windows: [{ hours_utc: "00:00-00:00", weekdays: [6, 7] }, { hours_utc: ["10:00-00:00"], weekdays: [1] }],
      },
    });
    expect(s?.tiers).toEqual([{ above_tokens: 100000, input: "0.5", cache_write_1h: "1" }]);
    expect(s?.rates.cache_write_5m).toBeNull();
    expect(s?.offPeak).toEqual({
      rates: { input: "0.05" },
      windows: [
        { hours_utc: ["00:00-00:00"], weekdays: [6, 7] },
        { hours_utc: ["10:00-00:00"], weekdays: [1] },
      ],
    });
  });

  test("an entry without a positive input and output price is unusable", () => {
    expect(normalizeLiteLLM({ input_cost_per_token: 1e-6 })).toBeNull();
    expect(normalizeLiteLLM({ input_cost_per_token: 0, output_cost_per_token: 1e-6 })).toBeNull();
    expect(normalizeLiteLLM(undefined)).toBeNull();
  });
});

describe("normalizeOpenRouter", () => {
  test("per-token decimal strings", () => {
    const s = normalizeOpenRouter({ id: "tencent/hy3", pricing: { prompt: "0.000000132", completion: "0.000000528", input_cache_read: "0.000000033" } });
    expect(s?.rates).toEqual({ input: "0.132", output: "0.528", cache_read: "0.033", cache_write_5m: null, cache_write_1h: null });
    expect(normalizeOpenRouter({ id: "x", pricing: { prompt: "-1", completion: "-1" } })).toBeNull();
  });
});

describe("change detection", () => {
  const base = normalizeLiteLLM({ input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7 });
  test("scheduleText is key-order independent", () => {
    const again = normalizeLiteLLM({ cache_read_input_token_cost: 1e-7, output_cost_per_token: 2e-6, input_cost_per_token: 1e-6 });
    expect(scheduleText(base!)).toBe(scheduleText(again!));
  });
  test("droppedRate names a rate that went away", () => {
    const next = normalizeLiteLLM({ input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 });
    expect(droppedRate(base!, next!)).toBe("cache_read");
    expect(droppedRate(next!, base!)).toBeNull();
  });
});
