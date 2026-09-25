import { describe, expect, test } from "bun:test";
import { computeCost, inUtcWindow } from "./pricing.ts";
import type { TokenCounts } from "./pricing.ts";

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
      grain: "message",
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
      grain: "message",
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
      grain: "message",
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
      grain: "message",
    });
    expect(result).toEqual({ usd: 20, source: "computed" });
  });

  test("claude-fable-5-1 has its own exact rate, not the Fable-5 family fallback", () => {
    // Fable 5.1 cut cache reads to $0.25/MTok from Fable 5's $1.00 — without
    // an exact entry this would silently resolve through FAMILY_PRICING's
    // "fable" tier at the stale $1.00 rate and report source "family".
    const result = computeCost("claude-fable-5-1", {
      input: 0,
      output: 0,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result).toEqual({ usd: 0.25, source: "computed" });
  });

  test("claude-opus-5-5 has its own exact rate, not the opus family fallback", () => {
    // The opus-tier FAMILY_PRICING fallback is $5/$25 (cacheRead 0.1x input);
    // Opus 5.5 is cheaper ($4/$20) with a steeper 0.05x cacheRead discount —
    // without an exact entry this silently resolved through the family tier at
    // the wrong rate and reported source "family".
    const result = computeCost("claude-opus-5-5", {
      input: 0,
      output: 0,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result).toEqual({ usd: 0.2, source: "computed" });
  });

  test("claude-sonnet-5 bills at its published $2/$10 rate, not the cancelled $3/$15 increase", () => {
    const result = computeCost("claude-sonnet-5", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result).toEqual({ usd: 12, source: "computed" });
  });

  test("a model with no cacheWrite1h rate falls back to the 5m rate", () => {
    const result = computeCost("gpt-5.6-terra", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 100_000,
      cacheWrite1h: 100_000,
      reasoning: 0,
      grain: "message",
    });
    // gpt-5.6-terra's cacheWrite rate (1.25x its $2.00 input) — see pricing.ts.
    // 100k, not 1M: a 1M-token prompt would correctly trip the long-context
    // schedule below and stop testing the 1h fallback.
    expect(result).toEqual({ usd: 0.25, source: "computed" });
  });

  // The rate cards the codex collector depends on. Pinned because the stale
  // Terra figures survived for months precisely because nothing asserted them.
  test.each([
    ["gpt-5.6-sol", 4.0, 20.0, 0.4, 5.0],
    ["gpt-6-astra", 10.0, 50.0, 1.0, 12.5],
    ["gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
    ["gpt-6-sol", 2.0, 10.0, 0.2, 2.5],
  ])("%s bills at its published short-context rate", (model, input, output, read, write) => {
    const per = (counts: Partial<TokenCounts>) =>
      computeCost(model as string, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        grain: "message",
        ...counts,
      }).usd;

    expect(per({ input: 1000 })).toBeCloseTo((input as number) / 1000, 10);
    expect(per({ output: 1000 })).toBeCloseTo((output as number) / 1000, 10);
    expect(per({ cacheRead: 1000 })).toBeCloseTo((read as number) / 1000, 10);
    expect(per({ cacheWrite: 1000 })).toBeCloseTo((write as number) / 1000, 10);
    // Reasoning bills at the output rate, never as a separate line.
    expect(per({ reasoning: 1000 })).toBeCloseTo((output as number) / 1000, 10);
  });

  test("switches to the long-context schedule above 272k prompt tokens", () => {
    const counts = (input: number): TokenCounts => ({
      input,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });

    // 272k exactly is still short context; one token more is not.
    const short = computeCost("gpt-6-astra", counts(272_000)).usd!;
    const long = computeCost("gpt-6-astra", counts(272_001)).usd!;

    expect(short).toBeCloseTo((272_000 * 10.0 + 1_000 * 50.0) / 1e6, 10);
    expect(long).toBeCloseTo((272_001 * 20.0 + 1_000 * 75.0) / 1e6, 10);
  });

  test("counts cache tokens toward the long-context threshold", () => {
    // The vendor measures the boundary on the whole prompt, so a mostly-cached
    // 300k prompt is long context even though `input` alone is tiny.
    const result = computeCost("gpt-5.6-sol", {
      input: 1_000,
      output: 0,
      cacheRead: 299_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result.usd).toBeCloseTo((1_000 * 8.0 + 299_000 * 0.8) / 1e6, 10);
  });

  test("the long-context schedule only applies to grain 'message'", () => {
    // A session-grain row (hermes/feuer/opencode) sums tokens across every
    // turn of the whole session, not one request — the same 300k total that
    // correctly trips the long schedule for a single message must NOT trip it
    // when it is really hundreds of small requests rolled up into one row.
    const counts: Omit<TokenCounts, "grain"> = {
      input: 1_000,
      output: 0,
      cacheRead: 299_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
    };

    const session = computeCost("gpt-5.6-sol", { ...counts, grain: "session" });
    const message = computeCost("gpt-5.6-sol", { ...counts, grain: "message" });

    expect(session.usd).toBeCloseTo((1_000 * 4.0 + 299_000 * 0.4) / 1e6, 10); // base rate
    expect(message.usd).toBeCloseTo((1_000 * 8.0 + 299_000 * 0.8) / 1e6, 10); // long rate
  });

  test("a model with no long schedule prices identically at any size", () => {
    const big = computeCost("claude-opus-5", {
      input: 5_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(big.usd).toBeCloseTo(25, 10); // 5M x $5/M, no surcharge
  });

  // Pinned 2026-09-13 measurements — see pricing.ts's inline notes. Both
  // regressions that mattered here: glm-5.3-flash silently staying at the
  // stale 08-28 half rate, and deepseek-v4.1-flash resolving to null (or,
  // worse, silently onto the retired v4-flash rate) instead of its own entry.
  test("glm-5.3-flash bills at its re-measured 2026-09-13 rate, not the stale 08-28 half rate", () => {
    const result = computeCost("glm-5.3-flash", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result.usd).toBeCloseTo(0.15 + 0.5 + 0.03 + 0.15, 10);
    expect(result.source).toBe("computed");
  });

  test("deepseek-v4.1-flash has its own rate, distinct from the retired deepseek-v4-flash", () => {
    // Re-measured 2026-09-25 06:46Z (peak, 0.30/1.20/0.006/0.30) — exactly
    // double the prior evening's 2026-09-24 figures (0.15/0.6/0.003/0.15),
    // pinned here previously; see pricing.ts's inline notes on the off-peak
    // hypothesis.
    const v41 = computeCost("deepseek-v4.1-flash", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(v41.usd).toBeCloseTo(0.3 + 1.2 + 0.006 + 0.3, 10);
    expect(v41.source).toBe("computed");

    const v4 = computeCost("deepseek-v4-flash", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(v4.usd).not.toBe(v41.usd);
  });

  test("unpriced model returns null cost", () => {
    const result = computeCost("some-unknown-model", {
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      grain: "message",
    });
    expect(result).toEqual({ usd: null, source: "none" });
  });
});

// The tier fallback exists so an unreleased Claude model costs something
// approximate instead of silently zero — which is how a whole Opus generation
// slipped through uncosted. These pin which models it may and may not catch.
describe("computeCost tier fallback", () => {
  const oneMillionIn: TokenCounts = {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    grain: "message",
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

describe("off-peak schedule (deepseek-v4.1-flash)", () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, grain: "message" as const };
  test("peak outside 16:30-00:30 UTC", () => {
    expect(computeCost("deepseek-v4.1-flash", { ...t, ts: "2026-09-25T06:46:00Z" }).usd).toBeCloseTo(0.3 + 1.2 + 0.006, 9);
  });
  test("off-peak inside the window, including after midnight", () => {
    expect(computeCost("deepseek-v4.1-flash", { ...t, ts: "2026-09-25T17:17:00Z" }).usd).toBeCloseTo(0.15 + 0.6 + 0.003, 9);
    expect(computeCost("deepseek-v4.1-flash", { ...t, ts: "2026-09-26T00:10:00Z" }).usd).toBeCloseTo(0.15 + 0.6 + 0.003, 9);
    expect(computeCost("deepseek-v4.1-flash", { ...t, ts: "2026-09-26T00:30:00Z" }).usd).toBeCloseTo(0.3 + 1.2 + 0.006, 9);
  });
  test("no timestamp prices at peak", () => {
    expect(computeCost("deepseek-v4.1-flash", t).usd).toBeCloseTo(0.3 + 1.2 + 0.006, 9);
  });
  test("inUtcWindow handles non-wrapping windows", () => {
    expect(inUtcWindow("2026-09-25T10:00:00Z", "09:00", "11:00")).toBe(true);
    expect(inUtcWindow("2026-09-25T11:00:00Z", "09:00", "11:00")).toBe(false);
  });
});
