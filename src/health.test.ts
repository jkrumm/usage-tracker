import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { collectors } from "./collectors/index.ts";
import { staleSources } from "./report.ts";
import { SCHEMA } from "./schema.ts";

function dbWith(rows: Array<[string, string]>): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  for (const [source, ts] of rows) {
    db.run(
      "INSERT INTO usage_record (source, source_id, grain, ts, billing, ingested_at) VALUES (?, ?, 'message', ?, 'iu', ?)",
      [source, `${source}-${ts}`, ts, ts],
    );
  }
  return db;
}

const NOW = new Date("2026-10-22T12:00:00Z");
const present = (source: string, staleAfterHours: number | null) => ({ source, staleAfterHours, available: () => true });

describe("staleSources", () => {
  test("flags a source whose newest row is older than its cadence", () => {
    const db = dbWith([["a", "2026-10-13T12:34:00Z"], ["b", "2026-10-22T11:00:00Z"]]);
    const stale = staleSources(db, [present("a", 48), present("b", 48)], NOW);
    expect(stale.map((s) => s.source)).toEqual(["a"]);
  });

  test("a present source with no rows is stale; null cadence and absent sources are ignored", () => {
    const db = dbWith([]);
    const absent = { source: "gone", staleAfterHours: 24, available: () => false };
    const stale = staleSources(db, [present("empty", 24), present("legacy", null), absent], NOW);
    expect(stale.map((s) => s.source)).toEqual(["empty"]);
  });

  test("a vanished store that once produced rows is stale; a future-dated newest row is not fresh", () => {
    const db = dbWith([["moved", "2026-10-13T12:00:00Z"], ["future", "2030-01-01T00:00:00Z"]]);
    const moved = { source: "moved", staleAfterHours: 48, available: () => false };
    const stale = staleSources(db, [moved, present("future", 48)], NOW);
    expect(stale.map((s) => s.source)).toEqual(["moved", "future"]);
  });

  test("age exactly at the limit is fresh", () => {
    const db = dbWith([["a", "2026-10-20T12:00:00Z"]]);
    expect(staleSources(db, [present("a", 48)], NOW)).toEqual([]);
  });
});

test("every registered collector declares its cadence (a number, or null for legacy/dormant)", () => {
  for (const c of collectors) expect(c.staleAfterHours === null || typeof c.staleAfterHours === "number").toBe(true);
});
