import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBudget, buildExplain, formatBudget, formatExplain, isOff } from "./budget.ts";
import { collectPortal } from "./collectors/iu-portal.ts";
import { openDb } from "./db.ts";

const NOW = Date.parse("2026-10-26T08:00:00Z");

/** 30 days ending 2026-10-26, $2/day on model A, plus $20 today on an untracked model. */
function seed(db: Database): Promise<number> {
  const periods: string[] = [];
  for (let i = 0; i < 31; i++) periods.push(new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10));
  const doc = {
    granularity: "daily",
    periods,
    rows: [
      { label: "Claude Haiku 5 5 Eu", row: 1, cells: Object.fromEntries(periods.map((p) => [p, 2])) },
      { label: "Untracked Thing", row: 2, cells: { "2026-10-26": 20 } },
    ],
  };
  return collectPortal(db, { now: NOW, fetch: async () => ({ code: 0, stdout: JSON.stringify(doc), stderr: "" }) });
}

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-budget-"));
  db = openDb(join(dir, "usage.db"));
  const ins = db.prepare(
    `INSERT INTO usage_record (source, source_id, grain, ts, model, model_norm, billing, cost_usd, ingested_at)
     VALUES ('s', ?, 'message', ?, ?, ?, 'iu', ?, 'x')`,
  );
  // tracked: $2/day on A except 10-20 ($0.50), and a model the portal never bills
  for (let d = 0; d < 31; d++) {
    const day = new Date(Date.UTC(2026, 8, 26 + d)).toISOString().slice(0, 10);
    ins.run(`a${d}`, `${day}T10:00:00Z`, "claude-haiku-5-5-eu", "claude-haiku-5-5", day === "2026-10-20" ? 0.5 : 2);
  }
  ins.run("g", "2026-10-10T10:00:00Z", "ghost-1", "ghost-1", 3);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildBudget", () => {
  test("rolling 30-day window, headroom, today's allowance and the next 7 drop-offs", async () => {
    await seed(db);
    const b = buildBudget(db, NOW)!;
    expect(b.today).toBe("2026-10-26");
    expect(b.windowStart).toBe("2026-09-27");
    expect(b.rolling30).toBe(80); // 30 × 2 + 20; 09-26 is outside the window
    expect(b.canSpendToday).toBe(500 - 58);
    expect(b.dropoff.map((d) => d.day)).toEqual([
      "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03",
    ]);
    expect(b.dropoff[0]).toEqual({ day: "2026-09-27", frees: 2, headroomAfter: 500 - 78 });
    expect(b.burn7).toBeCloseTo(34 / 7, 5); // 10-20..10-25 at $2 plus today's $22
    // in 7 days: drop 7 × $2 off the old end, add 7 days of burn
    expect(b.projected7).toBeCloseTo(80 - 14 + 34, 5);
  });

  test("compares portal and tracked per day and model, and flags what is off", async () => {
    await seed(db);
    const b = buildBudget(db, NOW)!;
    const oct20 = b.days.find((d) => d.key === "2026-10-20")!;
    expect(oct20).toMatchObject({ portal: 2, tracked: 0.5 });
    expect(isOff(oct20)).toBe(true); // |−1.5| > max(1, 0.4)
    expect(isOff({ portal: 2, tracked: 2.3 })).toBe(false);
    expect(b.unseen.map((c) => c.key)).toEqual(["Untracked Thing"]);
    expect(b.unbilled.map((c) => c.key)).toEqual(["ghost-1"]);
    const text = formatBudget(b, NOW);
    expect(text).toContain("rolling30");
    expect(text).not.toContain("OVER");
    expect(text).toContain("<-- off");
    expect(text).toContain("portal spend we do not track");
  });

  test("no portal data is a hint, not a crash", () => {
    expect(buildBudget(db, NOW)).toBeNull();
    expect(formatBudget(null)).toContain("make iu-portal");
  });

  test("over the cap is stated plainly", async () => {
    await seed(db);
    db.run("UPDATE iu_portal_cost SET cost_usd = 500 WHERE day = '2026-10-26' AND row = 2");
    expect(formatBudget(buildBudget(db, NOW), NOW)).toContain("OVER by");
  });
});

describe("buildExplain", () => {
  test("matches a model by normalized id or portal label and shows rates per day", async () => {
    await seed(db);
    db.run("UPDATE usage_record SET input_tokens = 1000000 WHERE source_id = 'a29'"); // 2026-10-25
    const e = buildExplain(db, "Claude-Haiku-5.5", NOW)!;
    expect(e.days[0]!.day).toBe("2026-10-26");
    const d = e.days.find((x) => x.day === "2026-10-25")!;
    expect(d).toMatchObject({ portal: 2, tracked: 2, calls: 1, tokens: 1_000_000 });
    expect(d.portalPerM).toBeCloseTo(2, 5);
    expect(d.bySource).toEqual([{ source: "s", usd: 2 }]);
    expect(formatExplain(e, "x")).toContain("total");
  });

  test("portal-only labels work and an unknown model is a message", async () => {
    await seed(db);
    expect(buildExplain(db, "untracked thing", NOW)!.days).toMatchObject([{ day: "2026-10-26", portal: 20, tracked: 0 }]);
    expect(formatExplain(buildExplain(db, "nope", NOW), "nope")).toContain("no portal or tracked rows");
  });
});
