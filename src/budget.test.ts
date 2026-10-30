import type { SQL } from "bun";
import { beforeEach, expect, test } from "bun:test";
import { buildBudget, buildExplain, formatBudget, formatExplain, isOff } from "./budget.ts";
import { migratedDb } from "./pg/fixture.ts";
import { saveState } from "./pg/state.ts";
import { describePg } from "./pg/testing.ts";

const NOW = Date.parse("2026-10-26T08:00:00Z");
const FETCHED = new Date(NOW).toISOString();

const pg = migratedDb();
let db: SQL;

/**
 * A stored portal report for one IU key, as the collector leaves it: one row per non-zero cell, the scrape state
 * (newest period = the portal's "today") and the Haiku label resolved to our model.
 */
async function seedPortal(
  iuKey: string,
  periods: string[],
  rows: Array<{ label: string; row: number; cells: Record<string, number> }>,
): Promise<void> {
  for (const r of rows) {
    const model = r.label.includes("Haiku") ? "claude-haiku-5-5" : null;
    for (const [day, usd] of Object.entries(r.cells)) {
      await db`INSERT INTO usage.iu_portal_cost (iu_key, day, label, "row", model, cost_usd, fetched_at)
               VALUES (${iuKey}, ${day}::date, ${r.label}, ${r.row}, ${model}, ${usd}, ${FETCHED}::timestamptz)`;
    }
  }
  const state = { lastOk: NOW, lastAttempt: NOW, lastCode: 0, lastDay: periods.at(-1) ?? null };
  await saveState(db, iuKey === "personal" ? "iu-portal" : `iu-portal:${iuKey}`, { cursor: JSON.stringify(state), status: "ok" });
}

/** A tracked IU row: cost_usd is set directly, the report only sums it. */
async function track(sourceId: string, ts: string, model: string | null, costUsd: number, apiKey = "personal", source = "s"): Promise<void> {
  await db`INSERT INTO usage.records (source, source_id, grain, ts, model, billing, api_key, cost_usd, cost_source)
           VALUES (${source}, ${sourceId}, 'message', ${ts}::timestamptz, ${model}, 'api_key', ${apiKey}, ${costUsd}, 'reported')`;
}

/** 30 days ending 2026-10-26, $2/day on model A, plus $20 today on an untracked model. */
async function seed(): Promise<void> {
  const periods: string[] = [];
  for (let i = 0; i < 31; i++) periods.push(new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10));
  await seedPortal("personal", periods, [
    { label: "Claude Haiku 5 5 Eu", row: 1, cells: Object.fromEntries(periods.map((p) => [p, 2])) },
    { label: "Untracked Thing", row: 2, cells: { "2026-10-26": 20 } },
  ]);
}

beforeEach(async () => {
  db = await pg.reset();
  // tracked: $2/day on A except 10-20 ($0.50), and a model the portal never bills
  for (let d = 0; d < 31; d++) {
    const day = new Date(Date.UTC(2026, 8, 26 + d)).toISOString().slice(0, 10);
    await track(`a${d}`, `${day}T10:00:00Z`, "claude-haiku-5-5", day === "2026-10-20" ? 0.5 : 2);
  }
  await track("g", "2026-10-10T10:00:00Z", "ghost-1", 3);
});

describePg("buildBudget", () => {
  test("rolling 30-day window, headroom, today's allowance and the next 7 drop-offs", async () => {
    await seed();
    const b = (await buildBudget(db, NOW))!;
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
    await seed();
    const b = (await buildBudget(db, NOW))!;
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

  test("no portal data is a hint, not a crash", async () => {
    expect(await buildBudget(db, NOW)).toBeNull();
    expect(formatBudget(null)).toContain("make iu-portal");
  });

  test("over the cap is stated plainly", async () => {
    await seed();
    await db`UPDATE usage.iu_portal_cost SET cost_usd = 500 WHERE day = '2026-10-26' AND "row" = 2`;
    expect(formatBudget(await buildBudget(db, NOW), NOW)).toContain("OVER by");
  });
});

describePg("buildBudget per IU key", () => {
  test("each key has its own report, tracked spend and cap", async () => {
    await seed();
    await seedPortal("athena-team", ["2026-10-25", "2026-10-26"], [
      { label: "Claude Haiku 5 5 Eu", row: 1, cells: { "2026-10-25": 30, "2026-10-26": 40 } },
    ]);
    await track("t1", "2026-10-26T10:00:00Z", null, 12, "athena-team", "athena-teamchat");
    const personal = (await buildBudget(db, NOW))!;
    const teamB = (await buildBudget(db, NOW, "athena-team"))!;
    expect(personal.rolling30).toBe(80);
    expect(teamB).toMatchObject({ iuKey: "athena-team", rolling30: 70, limitUsd: 500, canSpendToday: 500 - 30 });
    expect(teamB.days.find((d) => d.key === "2026-10-26")).toMatchObject({ portal: 40, tracked: 12 });
    expect(personal.days.find((d) => d.key === "2026-10-26")!.tracked).toBe(2);
    expect(formatBudget(teamB, NOW)).toContain("IU cap [athena-team]");
  });

  test("an unknown key is an error, a key without data is the hint", async () => {
    await expect(buildBudget(db, NOW, "nope")).rejects.toThrow("unknown IU key");
    expect(await buildBudget(db, NOW, "athena-team")).toBeNull();
  });
});

describePg("buildExplain", () => {
  test("matches a model by normalized id or portal label and shows rates per day", async () => {
    await seed();
    await db`UPDATE usage.records SET input_tokens = 1000000 WHERE source_id = 'a29'`; // 2026-10-25
    const e = (await buildExplain(db, "Claude-Haiku-5.5", NOW))!;
    expect(e.days[0]!.day).toBe("2026-10-26");
    const d = e.days.find((x) => x.day === "2026-10-25")!;
    expect(d).toMatchObject({ portal: 2, tracked: 2, calls: 1, tokens: 1_000_000 });
    expect(d.portalPerM).toBeCloseTo(2, 5);
    expect(d.bySource).toEqual([{ source: "s", usd: 2 }]);
    expect(formatExplain(e, "x")).toContain("total");
  });

  test("portal-only labels work and an unknown model is a message", async () => {
    await seed();
    expect((await buildExplain(db, "untracked thing", NOW))!.days).toMatchObject([{ day: "2026-10-26", portal: 20, tracked: 0 }]);
    expect(formatExplain(await buildExplain(db, "nope", NOW), "nope")).toContain("no portal or tracked rows");
  });
});
