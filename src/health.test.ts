import type { SQL } from "bun";
import { beforeEach, expect, test } from "bun:test";
import { collectors } from "./collectors/index.ts";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import { staleSources } from "./report.ts";

const pg = migratedDb();
let sql: SQL;

beforeEach(async () => {
  sql = await pg.reset();
});

/** Records of a source at the given timestamps; only `source` and `ts` matter to the freshness judgement. */
async function seed(rows: Array<[string, string]>): Promise<void> {
  for (const [source, ts] of rows) {
    await sql`
      INSERT INTO usage.records (source, source_id, grain, ts, billing, lane)
      VALUES (${source}, ${`${source}-${ts}`}, 'message', ${ts}::timestamptz, 'unknown', 'other')`;
  }
}

const NOW = new Date("2026-10-22T12:00:00Z");
const present = (source: string, staleAfterHours: number | null) => ({ source, staleAfterHours, available: () => true });

describePg("staleSources (Postgres)", () => {
  test("flags a source whose newest row is older than its cadence", async () => {
    await seed([["a", "2026-10-13T12:34:00Z"], ["b", "2026-10-22T11:00:00Z"]]);
    const stale = await staleSources(sql, [present("a", 48), present("b", 48)], NOW);
    expect(stale.map((s) => s.source)).toEqual(["a"]);
    expect(stale[0]).toMatchObject({ newestTs: "2026-10-13T12:34:00.000Z", limitHours: 48 });
  });

  test("the newest of a source's rows counts, not the first", async () => {
    await seed([["a", "2026-10-01T00:00:00Z"], ["a", "2026-10-22T10:00:00Z"]]);
    expect(await staleSources(sql, [present("a", 48)], NOW)).toEqual([]);
  });

  test("a present source with no rows is stale; null cadence and absent sources are ignored", async () => {
    const absent = { source: "gone", staleAfterHours: 24, available: () => false };
    const stale = await staleSources(sql, [present("empty", 24), present("legacy", null), absent], NOW);
    expect(stale.map((s) => s.source)).toEqual(["empty"]);
  });

  test("a vanished store that once produced rows is stale; a future-dated newest row is not fresh", async () => {
    await seed([["moved", "2026-10-13T12:00:00Z"], ["future", "2030-01-01T00:00:00Z"]]);
    const moved = { source: "moved", staleAfterHours: 48, available: () => false };
    const stale = await staleSources(sql, [moved, present("future", 48)], NOW);
    expect(stale.map((s) => s.source)).toEqual(["moved", "future"]);
  });

  test("age exactly at the limit is fresh", async () => {
    await seed([["a", "2026-10-20T12:00:00Z"]]);
    expect(await staleSources(sql, [present("a", 48)], NOW)).toEqual([]);
  });

  test("a source with its own freshness probe (no records) is judged on that", async () => {
    const probe = (newest: string | null) => ({ ...present("portal", 48), newest: async () => newest });
    expect((await staleSources(sql, [probe("2026-10-22T00:00:00.000Z")], NOW)).length).toBe(0);
    expect((await staleSources(sql, [probe("2026-10-10T00:00:00.000Z")], NOW)).map((s) => s.source)).toEqual(["portal"]);
  });
});

test("every registered collector declares its cadence (a number, or null for legacy/dormant)", () => {
  for (const c of collectors) expect(c.staleAfterHours === null || typeof c.staleAfterHours === "number").toBe(true);
});
