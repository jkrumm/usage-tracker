import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostResult } from "./argo.ts";
import { loadCursor, openDb } from "./db.ts";
import { syncPortal } from "./sync-portal.ts";

const CFG = { url: "http://argo.test", token: "t" };
const F1 = Date.parse("2026-10-26T12:00:00Z");
const F2 = Date.parse("2026-10-26T16:00:00Z");

let dir: string;
let db: Database;
let calls: Array<{ path: string; body: any; opts: unknown }>;
let result: PostResult;

const post = async (_cfg: unknown, path: string, body: unknown, opts: unknown = {}) => {
  calls.push({ path, body: body as any, opts });
  return result;
};

function seedCost(day: string, label: string, usd: number, fetchedAt: number, row = 0): void {
  db.prepare(
    `INSERT INTO iu_portal_cost (day, label, row, cost_usd, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, label, row) DO UPDATE SET cost_usd = excluded.cost_usd, fetched_at = excluded.fetched_at`,
  ).run(day, label, row, usd, fetchedAt);
}

const seedTotal = (month: string, usd: number, fetchedAt: number) =>
  db.prepare("INSERT OR REPLACE INTO iu_portal_total (month, total_usd, fetched_at) VALUES (?, ?, ?)").run(month, usd, fetchedAt);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-syncportal-"));
  db = openDb(join(dir, "usage.db"));
  calls = [];
  result = "ok";
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("syncPortal", () => {
  test("is disabled without Argo config and empty without portal rows", async () => {
    expect((await syncPortal(db, null, post)).status).toBe("disabled");
    expect((await syncPortal(db, CFG, post)).status).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  test("first run sends every row with totals, then advances the watermark", async () => {
    seedCost("2026-08-01", "GPT 5.6 Terra", 1.5, F1);
    seedCost("2026-10-26", "Haiku", 2, F1, 3);
    seedTotal("2026-10", 3.5, F1);
    expect(await syncPortal(db, CFG, post)).toEqual({ costs: 2, totals: 1, status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/usage/iu-portal");
    expect(calls[0]!.opts).toEqual({ tolerateMissing: true });
    expect(calls[0]!.body.costs[1]).toEqual({
      day: "2026-10-26", label: "Haiku", row: 3, model: null, costUsd: 2, fetchedAt: new Date(F1).toISOString(),
    });
    expect(calls[0]!.body.totals).toEqual([{ month: "2026-10", totalUsd: 3.5, fetchedAt: new Date(F1).toISOString() }]);
    expect(loadCursor(db, "argo_portal_fetched_at")).toBe(String(F1));
  });

  test("does nothing when no fetch landed since the watermark", async () => {
    seedCost("2026-10-26", "Haiku", 2, F1);
    await syncPortal(db, CFG, post);
    calls.length = 0;
    expect((await syncPortal(db, CFG, post)).status).toBe("unchanged");
    expect(calls).toHaveLength(0);
  });

  test("a new fetch resends the last 35 days but not older rows", async () => {
    seedCost("2026-08-01", "Old", 9, F1);
    seedCost("2026-09-27", "Window", 4, F1);
    seedCost("2026-10-26", "Today", 2, F1);
    await syncPortal(db, CFG, post);
    calls.length = 0;
    seedCost("2026-10-26", "Today", 5, F2);
    const r = await syncPortal(db, CFG, post);
    expect(r.status).toBe("ok");
    expect(calls[0]!.body.costs.map((c: any) => c.label)).toEqual(["Window", "Today"]);
    expect(calls[0]!.body.costs[1].costUsd).toBe(5);
    expect(loadCursor(db, "argo_portal_fetched_at")).toBe(String(F2));
  });

  test.each(["failed", "missing"] as const)("keeps the watermark when Argo answers %s", async (outcome) => {
    seedCost("2026-10-26", "Haiku", 2, F1);
    result = outcome;
    expect((await syncPortal(db, CFG, post)).status).toBe(outcome);
    expect(loadCursor(db, "argo_portal_fetched_at")).toBeNull();
    result = "ok";
    expect((await syncPortal(db, CFG, post)).status).toBe("ok");
  });

  test("splits more than 1000 rows into batches, totals only in the first", async () => {
    for (let i = 0; i < 1500; i++) seedCost("2026-10-26", "Bulk", 1, F1, i);
    seedTotal("2026-10", 1500, F1);
    expect((await syncPortal(db, CFG, post)).costs).toBe(1500);
    expect(calls.map((c) => c.body.costs.length)).toEqual([1000, 500]);
    expect(calls.map((c) => c.body.totals.length)).toEqual([1, 0]);
  });

  test("does not advance the watermark when a later batch fails", async () => {
    for (let i = 0; i < 1200; i++) seedCost("2026-10-26", "Bulk", 1, F1, i);
    let n = 0;
    const flaky = async (...args: Parameters<typeof post>): Promise<PostResult> => ((await post(...args)), ++n === 1 ? "ok" : "failed");
    expect((await syncPortal(db, CFG, flaky)).status).toBe("failed");
    expect(loadCursor(db, "argo_portal_fetched_at")).toBeNull();
  });
});
