import { beforeAll, expect, test } from "bun:test";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import { formatWindow, windowShare } from "./window.ts";

// One account, one interval (t0, t0+30 min] that moves the 5 h window by 10 and the 7 d window by 4.
// s1 (worker, role worker, repo r1) spent $3, s2 (interactive, no role, repo r2) $1 -> s1 7.5 / 3, s2 2.5 / 1.
// A second interval (+30, +60 min] moves the 5 h window by 2 with no record: residual 2 of 12.
describePg("window command", () => {
  const db = migratedDb();
  const at = (minutes: number) => new Date(Date.now() - 3_600_000 + minutes * 60_000).toISOString();

  beforeAll(async () => {
    const sql = await db.reset();
    const reading = (minutes: number, five: number, seven: number) =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES ('a', ${at(minutes)}, 'mini', ${five}, ${seven}, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`;
    await reading(0, 0, 0);
    await reading(30, 10, 4);
    await reading(60, 12, 4);
    const session = async (id: string, lane: string, detail: object | null, repo: string) => {
      const [row] = await sql`INSERT INTO usage.sessions (source, source_session_id, lane, lane_detail, repo)
                              VALUES ('claude-code', ${id}, ${lane}, ${detail === null ? null : JSON.stringify(detail)}::text::jsonb, ${repo}) RETURNING id`;
      return Number(row.id);
    };
    const s1 = await session("s1", "worker", { role: "worker" }, "r1");
    const s2 = await session("s2", "interactive", null, "r2");
    const record = (id: string, session: number, minutes: number, cost: number) =>
      sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, cost_usd)
          VALUES ('claude-code', ${id}, 'message', ${at(minutes)}, ${session}, 'max', 'a', ${cost})`;
    await record("r1", s1, 10, 3);
    await record("r2", s2, 20, 1);
  });

  test("groups the shares by session, lane, role and repo", async () => {
    const sql = await db.sql();
    const byLane = await windowShare(sql, { by: "lane" });
    expect(byLane.rows).toEqual([
      { key: "worker", fiveHourPct: 7.5, sevenDayPct: 3, sessions: 1 },
      { key: "interactive", fiveHourPct: 2.5, sevenDayPct: 1, sessions: 1 },
    ]);
    expect((await windowShare(sql, { by: "role" })).rows.map((r) => r.key)).toEqual(["worker", "(none)"]);
    expect((await windowShare(sql, { by: "repo", top: 1 })).rows.map((r) => r.key)).toEqual(["r1"]);
    expect((await windowShare(sql, { by: "session" })).rows.map((r) => r.key)).toEqual(["s1", "s2"]);
  });

  test("reports what the window moved and the residual nobody can be blamed for", async () => {
    const sql = await db.sql();
    const report = await windowShare(sql, { by: "lane" });
    expect(report.coverage).toEqual([
      { win: "five_hour", movedPts: 12, attributedPts: 10, residualPts: 2 },
      { win: "seven_day", movedPts: 4, attributedPts: 4, residualPts: 0 },
    ]);
    expect(formatWindow(report)).toContain("5h moved 12.0, attributed 10.0, residual 2.0 (16.7%");
  });

  test("filters by account and by days", async () => {
    const sql = await db.sql();
    expect((await windowShare(sql, { by: "lane", account: "other" })).rows).toEqual([]);
    expect((await windowShare(sql, { by: "lane", days: 0.001 })).rows).toEqual([]);
  });

  test("two sessions with one id in different sources stay two rows; a record without a session is its own row", async () => {
    const sql = await db.reset();
    const reading = (minutes: number, five: number) =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES ('a', ${at(minutes)}, 'mini', ${five}, 0, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`;
    await reading(0, 0);
    await reading(30, 9);
    const ids: number[] = [];
    for (const source of ["claude-code", "opencode"]) {
      const [row] = await sql`INSERT INTO usage.sessions (source, source_session_id, lane) VALUES (${source}, 'same-id', 'interactive') RETURNING id`;
      ids.push(Number(row.id));
    }
    let n = 0;
    const record = (session: number | null) =>
      sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, cost_usd)
          VALUES ('claude-code', ${`x${++n}`}, 'message', ${at(10)}, ${session}, 'max', 'a', 1)`;
    await record(ids[0] as number);
    await record(ids[1] as number);
    await record(null);
    const report = await windowShare(sql, { by: "session" });
    expect(report.rows.map((r) => `${r.key}=${r.fiveHourPct}`).sort()).toEqual(["(no session)=3", "same-id=3", "same-id=3"]);
    expect((await windowShare(sql, { by: "lane" })).rows.map((r) => r.key).sort()).toEqual(["(no session)", "interactive"]);
  });

  test("when the window moved with nothing to blame the report says so instead of 'run ingest'", async () => {
    const sql = await db.reset();
    await sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
              VALUES ('a', ${at(0)}, 'mini', 0, 0, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z'),
                     ('a', ${at(30)}, 'mini', 5, 0, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`;
    const text = formatWindow(await windowShare(sql, { by: "lane" }));
    expect(text).toContain("5h moved 5.0, attributed 0.0, residual 5.0 (100.0%");
    expect(text).not.toContain("run `ingest`");
    expect(formatWindow(await windowShare(sql, { by: "lane", account: "none" }))).toContain("run `ingest`");
  });
});
