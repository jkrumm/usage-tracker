import { describe, expect, test } from "bun:test";
import { computeCost } from "./pricing.ts";

// computeCost is where the 5m/1h cache-write split actually lands: miss the
// clamp or the tier lookup and cost either double-counts, goes negative, or
// silently falls back to the wrong rate. These cases pin the split's edges.

describe("computeCost", () => {
  test("all-5m cache write bills at the 5m rate", () => {
    const result = computeCost("claude-fable-5", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 0,
      reasoning: 0,
    });
    expect(result).toEqual({ usd: 12.5, source: "computed" });
  });

  test("all-1h cache write bills at the 1h rate", () => {
    const result = computeCost("claude-fable-5", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 1_000_000,
      reasoning: 0,
    });
    expect(result).toEqual({ usd: 20, source: "computed" });
  });

  test("a mixed split bills each portion at its own rate", () => {
    const result = computeCost("claude-fable-5", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 300_000,
      reasoning: 0,
    });
    // 700k @ 12.5/M (5m) + 300k @ 20/M (1h)
    const expected = (700_000 * 12.5 + 300_000 * 20) / 1_000_000;
    expect(result.usd).toBeCloseTo(expected, 10);
    expect(result.source).toBe("computed");
  });

  test("cacheWrite1h exceeding cacheWrite clamps to the all-1h cost", () => {
    const result = computeCost("claude-fable-5", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 5_000_000,
      reasoning: 0,
    });
    expect(result).toEqual({ usd: 20, source: "computed" });
  });

  test("a model with no cacheWrite1h rate falls back to the 5m rate", () => {
    const result = computeCost("gpt-5.6-terra", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 1_000_000,
      reasoning: 0,
    });
    expect(result).toEqual({ usd: 3.125, source: "computed" });
  });

  test("unpriced model returns null cost", () => {
    const result = computeCost("some-unknown-model", {
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
    });
    expect(result).toEqual({ usd: null, source: "none" });
  });
});

// The tier fallback exists so an unreleased Claude model costs something
// approximate instead of silently zero — which is how a whole Opus generation
// slipped through uncosted. These pin which models it may and may not catch.
describe("computeCost tier fallback", () => {
  const oneMillionIn = {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
  };

  test("an unlisted claude model bills at its tier's rate", () => {
    expect(computeCost("claude-opus-6", oneMillionIn)).toEqual({ usd: 5, source: "family" });
    expect(computeCost("claude-sonnet-6", oneMillionIn)).toEqual({ usd: 3, source: "family" });
    expect(computeCost("claude-haiku-5", oneMillionIn)).toEqual({ usd: 1, source: "family" });
    expect(computeCost("claude-fable-6", oneMillionIn)).toEqual({ usd: 10, source: "family" });
  });

  test("an exact rate wins over the tier fallback", () => {
    // haiku-4-5 lists at 1/M input — same as its tier, so assert the source,
    // which is what separates a known rate from an assumed one.
    expect(computeCost("claude-haiku-4-5", oneMillionIn).source).toBe("computed");
    expect(computeCost("claude-opus-5", oneMillionIn)).toEqual({ usd: 5, source: "computed" });
  });

  test("a non-claude model containing a tier word does not fall back", () => {
    expect(computeCost("opus-clone-v1", oneMillionIn)).toEqual({ usd: null, source: "none" });
  });
});
