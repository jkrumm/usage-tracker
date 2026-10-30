import { expect, test } from "bun:test";
import { migrate } from "../pg/migrate.ts";
import { describePg, scratchDb } from "../pg/testing.ts";
import { applyHistory, type Snapshot } from "./history.ts";
import { LITELLM_FIXTURE } from "./testing.ts";

const silent = { info() {}, warn() {}, error() {} };
const snap = (sha: string, iso: string, edit: (c: Record<string, Record<string, unknown>>) => void = () => {}): Snapshot => {
  const catalog = structuredClone(LITELLM_FIXTURE) as Record<string, Record<string, unknown>>;
  edit(catalog);
  return { sha, date: new Date(iso), catalog };
};
async function* of(...s: Snapshot[]) {
  for (const x of s) yield x;
}

describePg("prices-seed-history", () => {
  const db = scratchDb();

  const history = () => [
    snap("aaa", "2026-04-01T12:00:00Z"),
    snap("bbb", "2026-04-02T12:00:00Z"),
    snap("ccc", "2026-04-03T12:00:00Z", (c) => {
      c["claude-sonnet-5"]!.input_cost_per_token = 0.000003;
    }),
    snap("ddd", "2026-04-04T12:00:00Z", (c) => {
      delete c["claude-opus-5"]; // a snapshot that lacks a key says nothing: the old schedule stands
      c["claude-sonnet-5"]!.input_cost_per_token = 0.000003;
    }),
  ];

  test("writes a row per model on the first snapshot and then only on change", async () => {
    const sql = await db.connect();
    await migrate(sql);
    const r = await applyHistory(sql, of(...history()), silent);
    expect(r.snapshots).toBe(4);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.prices WHERE source = 'seed-git'`;
    const [{ k }] = await sql`SELECT count(DISTINCT model_key)::int AS k FROM usage.prices`;
    expect(n).toBe(k + 1);
    const rows = await sql`SELECT input::float8 AS input, source_ref, valid_from FROM usage.prices WHERE model_key = 'claude-sonnet-5' ORDER BY valid_from`;
    expect(rows.map((x: { input: number; source_ref: string }) => [x.input, x.source_ref])).toEqual([
      [2, "aaa"],
      [3, "ccc"],
    ]);
    expect(new Date(rows[1].valid_from).toISOString()).toBe("2026-04-03T12:00:00.000Z");
    const [{ o }] = await sql`SELECT count(*)::int AS o FROM usage.prices WHERE model_key = 'claude-opus-5'`;
    expect(o).toBe(1);
  });

  test("a second run writes nothing", async () => {
    const sql = await db.connect();
    const [{ before }] = await sql`SELECT count(*)::int AS before FROM usage.prices`;
    const r = await applyHistory(sql, of(...history()), silent);
    expect(r.inserted).toBe(0);
    const [{ after }] = await sql`SELECT count(*)::int AS after FROM usage.prices`;
    expect(after).toBe(before);
  });

  test("history seeded after a live sync slots in before it", async () => {
    const sql = await db.connect();
    await sql`DELETE FROM usage.prices WHERE model_key = 'claude-sonnet-5'`;
    await sql`INSERT INTO usage.prices (model_key, valid_from, input, output, source)
              VALUES ('claude-sonnet-5', '2026-10-01', 3, 10, 'litellm')`;
    const r = await applyHistory(sql, of(...history()), silent);
    expect(r.inserted).toBe(2); // the 2.0 baseline and the 3.0 change; the later live row is left alone
    const rows = await sql`SELECT input::float8 AS input, source FROM usage.prices WHERE model_key = 'claude-sonnet-5' ORDER BY valid_from`;
    expect(rows.map((x: { input: number; source: string }) => [x.input, x.source])).toEqual([
      [2, "seed-git"],
      [3, "seed-git"],
      [3, "litellm"],
    ]);
  });
});
