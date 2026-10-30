import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { migratedDb } from "../pg/fixture.ts";
import { describePg } from "../pg/testing.ts";

// migrations/pg/0005_price_overrides_iu.sql carries the IU-specific rates of the retired src/pricing.ts; 0006 removed its three
// DeepSeek rows again (the catalog schedule fits the portal better, docs/reconciliation/2026-10-30-portal-actuals.md). The expected
// costs below were computed with that file's computeCost (before it was deleted) for one fixed token mix and are
// pinned here to the micro-dollar: 1M input, 200k output, 5M cache read, 300k cache write (100k of it at 1h), 50k reasoning.

const TOKENS = { input: 1_000_000, output: 200_000, cacheRead: 5_000_000, cw5m: 200_000, cw1h: 100_000, reasoning: 50_000 };

const OLD_PRICING_COSTS: Array<[model: string, ts: string, usd: number | null]> = [
  ["hy3", "2026-08-30T12:00:00Z", 0.502],
  ["kimi-k2.7-code", "2026-09-01T12:00:00Z", 3.185],
  ["glm-5.1", "2026-08-31T12:00:00Z", 4.22],
  ["glm-5.2", "2026-08-31T12:00:00Z", 3.62],
  ["mimo-v2.5-pro", "2026-08-31T12:00:00Z", 3.05],
  ["nvidia-nemotron-3-super-120b-a12b", "2026-08-31T12:00:00Z", 0.755], // cache read = input
  ["nemotron-3-ultra", "2026-08-31T12:00:00Z", 1.98],
  ["qwen3.7-max", "2026-08-31T12:00:00Z", 17.625], // cache read = input
  ["gemini-3-pro-preview", "2026-05-21T12:00:00Z", 6.6],
  ["gpt-image-2", "2026-09-01T12:00:00Z", 20.25],
  ["gpt-image-2.5-flare", "2026-10-01T12:00:00Z", 20.25],
  ["gpt-image-2.5-sunburst", "2026-10-01T12:00:00Z", 20.25],
  ["gemma4-agent", "2026-04-14T12:00:00Z", null], // free local model: unpriced, never an override
];

const pg = migratedDb();

async function cost(sql: SQL, model: string, ts: string) {
  const [r] = await sql`
    SELECT cost_usd::float8 AS usd, cost_source AS source, price_id
    FROM usage.compute_cost(${model}, ${ts}::timestamptz, ${TOKENS.input}, ${TOKENS.output}, ${TOKENS.cacheRead},
                            ${TOKENS.cw5m}, ${TOKENS.cw1h}, ${TOKENS.reasoning}, 'message')`;
  return r as { usd: number | null; source: string; price_id: number | null };
}

describePg("0005 price_overrides_iu", () => {
  test("prices the old pricing.ts pairs to the same cost", async () => {
    const sql = await pg.sql();
    for (const [model, ts, usd] of OLD_PRICING_COSTS) {
      const got = await cost(sql, model, ts);
      if (usd === null) {
        expect(got, `${model} stays unpriced`).toMatchObject({ usd: null, source: "none" });
        continue;
      }
      expect(got.usd, `${model} @ ${ts}`).toBeCloseTo(usd, 6);
      expect(got.source).toBe("override");
    }
  });

  test("every row names its measurement and the IU-measured ones supersede the catalog", async () => {
    const sql = await pg.sql();
    const rows = await sql`SELECT model, supersedes_prices, reason, valid_to FROM usage.price_overrides ORDER BY model`;
    const priced = new Set(OLD_PRICING_COSTS.filter(([, , usd]) => usd !== null).map(([model]) => model));
    expect(rows.map((r: { model: string }) => r.model).sort()).toEqual([...priced].sort()); // one row per priced model, none for the free one
    for (const r of rows) {
      expect(r.reason.length, r.model).toBeGreaterThan(40);
      expect(r.valid_to).toBeNull();
    }
    const listPrice = rows.filter((r: { supersedes_prices: boolean }) => !r.supersedes_prices).map((r: { model: string }) => r.model);
    expect(listPrice).toEqual(["gemini-3-pro-preview", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
  });

  test("the DeepSeek models follow the catalog since 0006: no override, off-peak windows included", async () => {
    const sql = await pg.sql();
    expect(await sql`SELECT 1 FROM usage.price_overrides WHERE model LIKE 'deepseek-%'`).toHaveLength(0);
    const offPeak = JSON.stringify({
      rates: { input: 0.15, output: 0.6, cache_read: 0.003 },
      windows: [{ weekdays: [1, 2, 3, 4, 5], hours_utc: ["00:00-01:00", "04:00-06:00", "10:00-00:00"] }, { weekdays: [6, 7], hours_utc: ["00:00-00:00"] }],
    });
    await sql`INSERT INTO usage.prices (model_key, valid_from, input, output, cache_read, off_peak, source)
              VALUES ('deepseek/deepseek-v4-flash', '2026-01-01T00:00:00Z', 0.3, 1.2, 0.006, ${offPeak}::text::jsonb, 'litellm')`;
    await sql`INSERT INTO usage.price_aliases (model, model_key, matched_by) VALUES ('deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash', 'data')`;
    await sql`INSERT INTO usage.prices (model_key, valid_from, input, output, cache_read, source)
              VALUES ('gpt-image-2', '2026-01-01T00:00:00Z', 6, 31, 1.5, 'litellm')`;
    try {
      // Saturday midday is off-peak in the catalog: 0.5 x the peak 0.72 ... for this token mix 1M in, 200k out, 5M read, 300k writes, 50k reasoning
      const sat = await cost(sql, "deepseek-v4.1-flash", "2026-10-10T12:00:00Z");
      expect(sat).toMatchObject({ source: "prices" });
      expect(sat.usd).toBeCloseTo(0.36, 6);
      const wedPeak = await cost(sql, "deepseek-v4.1-flash", "2026-10-28T06:46:00Z");
      expect(wedPeak.usd).toBeCloseTo(0.72, 6);
      // A list-price fill (supersedes_prices = false) yields to a catalog row.
      expect(await cost(sql, "gpt-image-2", "2026-09-01T12:00:00Z")).toMatchObject({ source: "prices" });
    } finally {
      await sql`DELETE FROM usage.price_aliases WHERE model = 'deepseek-v4.1-flash'`;
      await sql`DELETE FROM usage.prices WHERE model_key IN ('deepseek/deepseek-v4-flash', 'gpt-image-2')`;
    }
  });
});
