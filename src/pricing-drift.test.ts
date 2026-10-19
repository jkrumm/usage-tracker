import { describe, expect, test } from "bun:test";
import { PRICING } from "./pricing.ts";
import { checkPricingDrift, REQUESTY_MAP, type RequestyModel } from "./pricing-drift.ts";

// Requesty reports USD per token; PRICING is USD per 1M tokens. The fixture is
// built from PRICING so these tests pin the comparison logic, not today's rates.
const fixture = (over: Partial<Record<"input" | "output" | "cached", number>> = {}): RequestyModel[] => {
  const p = PRICING["deepseek-v4.1-flash"]!;
  return [
    {
      id: "deepseek/deepseek-v4.1-flash",
      input_price: (over.input ?? p.input) / 1e6,
      output_price: (over.output ?? p.output) / 1e6,
      cached_price: (over.cached ?? p.cacheRead) / 1e6,
    },
  ];
};

describe("checkPricingDrift", () => {
  test("every mapped IU id exists in PRICING", () => {
    for (const iuId of Object.keys(REQUESTY_MAP)) expect(PRICING[iuId]).toBeDefined();
  });

  test("matching rates report ok and exit 0", () => {
    const result = checkPricingDrift(fixture());
    expect(result.ok).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("ok");
  });

  test("a difference within 1% is not drift", () => {
    const p = PRICING["deepseek-v4.1-flash"]!;
    expect(checkPricingDrift(fixture({ output: p.output * 1.005 })).ok).toBe(true);
  });

  test("a difference above 1% is drift, shown with both values", () => {
    const result = checkPricingDrift(fixture({ output: 1.5 }));
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("drift");
    expect(result.lines[0]).toContain("output 1.2 vs 1.5");
  });

  test("a mapped id missing upstream fails", () => {
    const result = checkPricingDrift([]);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("missing upstream");
  });

  test("an unmapped upstream model is ignored", () => {
    const result = checkPricingDrift([
      ...fixture(),
      { id: "other/model", input_price: 1, output_price: 1, cached_price: 1 },
    ]);
    expect(result.ok).toBe(true);
  });
});
