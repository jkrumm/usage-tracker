import { expect, test } from "bun:test";
import { migrate } from "../pg/migrate.ts";
import { describePg, scratchDb } from "../pg/testing.ts";
import { ALIASES } from "./aliases.ts";
import { syncPrices } from "./sync.ts";
import { fixtureDeps, LITELLM_FIXTURE } from "./testing.ts";

const distinctKeys = new Set(ALIASES.map((a) => a.modelKey)).size;
const clone = () => structuredClone(LITELLM_FIXTURE) as Record<string, Record<string, unknown>>;

describePg("prices-sync", () => {
  const db = scratchDb();
  const count = async (sql: Awaited<ReturnType<typeof db.connect>>, where = "true") =>
    Number((await sql.unsafe(`SELECT count(*) AS n FROM usage.prices WHERE ${where}`))[0].n);

  test("first run writes one row per aliased model, the second run writes none", async () => {
    const sql = await db.connect();
    await migrate(sql);
    const first = await syncPrices(sql, fixtureDeps());
    expect(first).toEqual({ checked: distinctKeys, inserted: distinctKeys, unchanged: 0, errors: 0 });
    const rows = await count(sql);
    expect(rows).toBe(distinctKeys);

    const second = await syncPrices(sql, fixtureDeps({ now: () => new Date("2026-10-31T04:20:00Z") }));
    expect(second).toEqual({ checked: distinctKeys, inserted: 0, unchanged: distinctKeys, errors: 0 });
    expect(await count(sql)).toBe(rows);
  });

  test("seeds the aliases with how they matched", async () => {
    const sql = await db.connect();
    const [row] = await sql`SELECT model_key, matched_by FROM usage.price_aliases WHERE model = 'deepseek-v4.1-flash'`;
    expect(row).toMatchObject({ model_key: "deepseek/deepseek-v4-flash", matched_by: "data" });
    expect(await count(sql, "source = 'openrouter'")).toBe(2);
  });

  test("a changed rate writes exactly one new row stamped with the fetch time", async () => {
    const sql = await db.connect();
    const cat = clone();
    cat["claude-sonnet-5-5"]!.input_cost_per_token = 0.0000015;
    const now = new Date("2026-11-02T04:20:00Z");
    const r = await syncPrices(sql, fixtureDeps({ litellm: cat, now: () => now }));
    expect(r).toMatchObject({ inserted: 1, errors: 0 });
    const rows = await sql`SELECT input::text AS input, valid_from FROM usage.prices WHERE model_key = 'claude-sonnet-5-5' ORDER BY valid_from`;
    expect(rows.map((x: { input: string }) => Number(x.input))).toEqual([2, 1.5]);
    expect(new Date(rows[1].valid_from).toISOString()).toBe(now.toISOString());
  });

  test("a key that vanished upstream is an error and keeps the previous row", async () => {
    const sql = await db.connect();
    const before = await count(sql, "model_key = 'claude-opus-5'");
    const cat = clone();
    delete cat["claude-opus-5"];
    const errors: string[] = [];
    const r = await syncPrices(sql, fixtureDeps({ litellm: cat, now: () => new Date("2026-11-03T04:20:00Z"), log: { info() {}, warn() {}, error: (m) => errors.push(m) } }));
    expect(r.errors).toBe(1);
    expect(errors[0]).toContain("claude-opus-5 vanished upstream");
    expect(await count(sql, "model_key = 'claude-opus-5'")).toBe(before);
  });

  test("a zeroed price or a dropped cache rate never becomes a row", async () => {
    const sql = await db.connect();
    const cat = clone();
    cat["claude-opus-5-5"]!.input_cost_per_token = 0;
    delete cat["claude-fable-5"]!.cache_read_input_token_cost;
    const r = await syncPrices(sql, fixtureDeps({ litellm: cat, now: () => new Date("2026-11-04T04:20:00Z") }));
    expect(r.errors).toBe(2);
    expect(r.inserted).toBe(0);
    expect(await count(sql, "model_key IN ('claude-opus-5-5', 'claude-fable-5') AND valid_from > '2026-11-01'")).toBe(0);
  });
});
