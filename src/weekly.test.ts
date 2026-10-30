import { beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import {
  FINDING_THRESHOLDS,
  formatWeekly,
  isoWeekOf,
  lastFullIsoWeek,
  parseIsoWeek,
  trackFindings,
  weeklyReport,
  writeWeekly,
  type FindingThresholds,
  type RawFinding,
} from "./weekly.ts";

test("parses ISO weeks, their boundaries and the year edges", () => {
  expect(parseIsoWeek("2026-W43").from.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  expect(parseIsoWeek("2026-W43").to.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  expect(parseIsoWeek("2025-W01").from.toISOString()).toBe("2024-12-30T00:00:00.000Z"); // week 1 starts in the previous year
  expect(parseIsoWeek("2026-W53").from.toISOString()).toBe("2026-12-28T00:00:00.000Z"); // 2026 has 53 weeks
  expect(parseIsoWeek("2026-W53").to.toISOString()).toBe("2027-01-04T00:00:00.000Z");
  expect(parseIsoWeek("2027-W01").from.toISOString()).toBe("2027-01-04T00:00:00.000Z");
  expect(isoWeekOf(new Date("2027-01-03T23:59:59Z")).label).toBe("2026-W53");
  expect(isoWeekOf(new Date("2021-01-03T12:00:00Z")).label).toBe("2020-W53");
  for (const bad of ["2027-W53", "2026-W00", "2026-W54", "2026-43", "2026-W4", "26-W43", "", "2026-w43", " 2026-W43"]) {
    expect(() => parseIsoWeek(bad)).toThrow();
  }
});

test("the default week is the last one that has fully passed", () => {
  expect(lastFullIsoWeek(new Date("2026-10-30T12:00:00Z")).label).toBe("2026-W43");
  expect(lastFullIsoWeek(new Date("2026-10-26T00:00:00Z")).label).toBe("2026-W43"); // Monday 00:00 closes W43
  expect(lastFullIsoWeek(new Date("2026-10-25T23:59:59Z")).label).toBe("2026-W42");
  expect(lastFullIsoWeek(new Date("2027-01-04T00:00:00Z")).label).toBe("2026-W53");
  expect(lastFullIsoWeek(new Date("2027-01-03T00:00:00Z")).label).toBe("2026-W52");
});

// Fixture, one account `a`, 2026-W43 (T = Mon 2026-10-19) against 2026-W42 (P = T - 7 d). The quota resets are far in the future,
// so every reading is the same window and a delta is the difference of two readings.
//
// W42: P+1h 0/0, P+2h 10/3 (5h/7d). p1 (worker, role worker, sonnet) and p2 (interactive, opus) hold $2 each of that interval, so each
//      gets 5 (5h) and 1.5 (7d). p1 has two requests with 700 of 1000 input tokens read from cache (0.7).
// W43: T+1h 10/3 (no movement), T+2h 30/8, T+3h 36/11, T+4h 36/13.
//   interval 1 (5h +20, 7d +5), records: s1 $6, s2 $2, s3 $2    -> s1 12/3, s2 4/1, s3 4/1
//   interval 2 (5h +6, 7d +3), records: s3 $1, s4 $2            -> s3 +2/+1, s4 4/2
//   interval 3 (7d +2) has no record: residual.
//   moved 26 / 10, attributed 26 / 8, residual 0 / 2 (20 %). Previous week moved 10 / 3.
//   lane:  worker (s1, s2) 16/4, interactive (s3) 6/2, subagent (s4) 4/2      prev: worker 5/1.5, interactive 5/1.5
//   role:  worker (s1, s2) 16/4, (none) 10/4
//   subagent type: Explore (s4) 4/2, (none) 22/6
//   sessions by 7d: s1 3, s3 2 (5h 6), s4 2 (5h 4), s2 1
//   cache: worker in 200, read 1400, write 100 -> 1400/1700; interactive 980/1000 = 0.98; subagent 0.5 (not a main lane)
//   unattributed but active in W43 (no records, share 0): s5 worker/opus, s6 worker/sonnet (both role worker), s7 subagent Explore
//   -> worker lane and role: 4 sessions (Opus mean (3+0)/2 = 1.5, Sonnet (1+0)/2 = 0.5, ratio 3), Explore 2 sessions (1 pt per session),
//      worker compactions 2 over 4 sessions = 0.5 per session, role (none) 3 sessions, subagent lane 2.
//   quota account z: flat readings (5/5) in W38 and W39 only: readings without movement.
//   events: skill wave 10k/12k/14k chars (W42: 3 x 9k), small 3 x 1k, rare 1 x 20k (W42: old 4 x 10k); compactions: 2 in s1, 1 in s3.
//   hostile skill names: example.com 3 x 30k, 10.0.0.1 / op://x/y / a@b.c 1 x 5k each -> one (other) row: 6 loads, 105k chars.
describePg("weekly report", () => {
  const db = migratedDb();
  const T = Date.parse("2026-10-19T00:00:00Z");
  const P = T - 7 * 86_400_000;
  const at = (base: number, hours: number) => new Date(base + hours * 3_600_000).toISOString();
  // Test thresholds: small enough for the fixture; the production values are asserted separately.
  const th: FindingThresholds = {
    skillSize: { minLoads: 3, minAvgChars: 8000 },
    subagentEffort: { minSessions: 2, topRank: 3 },
    roleTier: { minShare: 0.25, minSpawnsPerModel: 2, minRatio: 2 },
    compactionRate: { minSessions: 2, minPerSession: 0.5 },
    cacheRatio: { maxRatio: 0.9, minRequests: 2 },
  };
  const NOW = new Date("2026-10-30T12:00:00Z");

  beforeAll(async () => {
    const sql = await db.reset();
    const reading = (base: number, hours: number, five: number, seven: number, account = "a") =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES (${account}, ${at(base, hours)}, 'mini', ${five}, ${seven}, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z')`;
    await reading(P, 1, 0, 0);
    await reading(P, 2, 10, 3);
    await reading(T, 1, 10, 3);
    await reading(T, 2, 30, 8);
    await reading(T, 3, 36, 11);
    await reading(T, 4, 36, 13);
    for (const base of [T - 35 * 86_400_000, T - 28 * 86_400_000]) for (const h of [1, 2]) await reading(base, h, 5, 5, "z");

    // W36, account y: 5h readings only. Sample 1 has no 7d pct, sample 2 has a 7d pct but no resets_at: neither is a 7d reading.
    const W36 = T - 49 * 86_400_000;
    await sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at) VALUES
              ('y', ${at(W36, 1)}, 'mini', 0, NULL, '2099-01-01T00:00:00Z', '2099-01-02T00:00:00Z'),
              ('y', ${at(W36, 2)}, 'mini', 4, 5, '2099-01-01T00:00:00Z', NULL)`;
    const [y1] = await sql`INSERT INTO usage.sessions (source, source_session_id, lane, account, first_ts, last_ts)
                           VALUES ('claude-code', 'y1', 'worker', 'y', ${at(W36, 1.2)}, ${at(W36, 1.8)}) RETURNING id`;
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, lane, cost_usd, input_tokens)
              VALUES ('claude-code', 'ry1', 'message', ${at(W36, 1.5)}, ${Number(y1.id)}, 'max', 'y', 'worker', 2, 10)`;
    // W35, account x: 6 points of the 5h window caused by a record that has no session.
    const W35 = T - 56 * 86_400_000;
    await reading(W35, 1, 0, 0, "x");
    await reading(W35, 2, 6, 0, "x");
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, lane, cost_usd, input_tokens)
              VALUES ('claude-code', 'rx1', 'message', ${at(W35, 1.5)}, NULL, 'max', 'x', 'other', 3, 10)`;

    const session = async (
      id: string, lane: string, detail: object | null, o: { model: string; effort?: string; repo?: string; issue?: string; base: number },
    ) => {
      const [row] = await sql`INSERT INTO usage.sessions (source, source_session_id, lane, lane_detail, model, effort, repo, issue_id, account, first_ts, last_ts)
        VALUES ('claude-code', ${id}, ${lane}, ${detail === null ? null : JSON.stringify(detail)}::text::jsonb, ${o.model}, ${o.effort ?? "high"},
                ${o.repo ?? "r1"}, ${o.issue ?? null}, 'a', ${at(o.base, 1.5)}, ${at(o.base, 2.5)}) RETURNING id`;
      return Number(row.id);
    };
    const p1 = await session("p1", "worker", { role: "worker" }, { model: "sonnet-5-5", base: P });
    const p2 = await session("p2", "interactive", null, { model: "opus-5-5", base: P });
    const s1 = await session("s1-aaaaaaaa-bbbb", "worker", { role: "worker" }, { model: "opus-5-5", repo: "r1", issue: "EP-1", base: T });
    const s2 = await session("s2-aaaaaaaa-bbbb", "worker", { role: "worker" }, { model: "sonnet-5-5", repo: "ops@example.com", issue: "op://vault/item", base: T });
    const s3 = await session("s3-aaaaaaaa-bbbb", "interactive", null, { model: "opus-5-5", effort: "medium", repo: "r2", base: T });
    const s4 = await session("s3-aaaaaaaa-bbbb:agent-1", "subagent", { subagent_type: "Explore" }, { model: "sonnet-5-5", repo: "r2", base: T });
    const s5 = await session("s5-aaaaaaaa-bbbb", "worker", { role: "worker" }, { model: "opus-5-5", base: T });
    const s6 = await session("s6-aaaaaaaa-bbbb", "worker", { role: "worker" }, { model: "sonnet-5-5", base: T });
    const s7 = await session("s3-aaaaaaaa-bbbb:agent-2", "subagent", { subagent_type: "Explore" }, { model: "sonnet-5-5", repo: "r2", base: T });
    await sql`UPDATE usage.sessions SET parent_session_id = ${s3} WHERE id IN (${s4}, ${s7})`;
    expect([s5, s6]).toHaveLength(2);

    let n = 0;
    const record = (session: number, lane: string, ts: string, cost: number, tokens: { input: number; read: number; write?: number }) =>
      sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, lane, cost_usd, input_tokens, cache_read_tokens, cache_write_5m_tokens)
          VALUES ('claude-code', ${`r${++n}`}, 'message', ${ts}, ${session}, 'max', 'a', ${lane}, ${cost}, ${tokens.input}, ${tokens.read}, ${tokens.write ?? 0})`;
    await record(p1, "worker", at(P, 1.5), 1, { input: 50, read: 350, write: 100 });
    await record(p1, "worker", at(P, 1.6), 1, { input: 50, read: 350, write: 100 });
    await record(p2, "interactive", at(P, 1.7), 2, { input: 50, read: 950 });
    await record(s1, "worker", at(T, 1.5), 6, { input: 100, read: 800, write: 100 });
    await record(s2, "worker", at(T, 1.6), 2, { input: 100, read: 600 });
    await record(s3, "interactive", at(T, 1.7), 2, { input: 10, read: 490 });
    await record(s3, "interactive", at(T, 2.5), 1, { input: 10, read: 490 });
    await record(s4, "subagent", at(T, 2.6), 2, { input: 500, read: 500 });

    let e = 0;
    const skill = (week: number, session: string, name: string, size: number | null, hours: number) =>
      sql`INSERT INTO usage.session_events (source, event_id, source_session_id, kind, ts, name, size_chars)
          VALUES ('claude-code', ${`e${++e}`}, ${session}, 'skill', ${at(week, hours)}, ${name}, ${size})`;
    for (const size of [10_000, 12_000, 14_000]) await skill(T, "s1-aaaaaaaa-bbbb", "wave", size, 2);
    for (let i = 0; i < 3; i++) await skill(T, "s1-aaaaaaaa-bbbb", "small", 1000, 2);
    await skill(T, "s1-aaaaaaaa-bbbb", "rare", 20_000, 2);
    for (let i = 0; i < 3; i++) await skill(P, "p1", "wave", 9000, 2);
    for (let i = 0; i < 4; i++) await skill(P, "p1", "old", 10_000, 2);
    await skill(T, "s1-aaaaaaaa-bbbb", "example.com", 30_000, 2);
    await skill(T, "s1-aaaaaaaa-bbbb", "example.com", 30_000, 2);
    await skill(T, "s1-aaaaaaaa-bbbb", "example.com", 30_000, 2);
    for (const name of ["10.0.0.1", "op://x/y", "a@b.c"]) await skill(T, "s1-aaaaaaaa-bbbb", name, 5000, 2);
    const compaction = (session: string, hours: number) =>
      sql`INSERT INTO usage.session_events (source, event_id, source_session_id, kind, ts) VALUES ('claude-code', ${`e${++e}`}, ${session}, 'compaction', ${at(T, hours)})`;
    await compaction("s1-aaaaaaaa-bbbb", 2);
    await compaction("s1-aaaaaaaa-bbbb", 3);
    await compaction("s3-aaaaaaaa-bbbb", 3);
  });

  const week = async (thresholds: FindingThresholds = th) => weeklyReport(await db.sql(), { week: "2026-W43", thresholds });
  const row = <T extends { key: string }>(rows: T[], key: string) => rows.find((r) => r.key === key);

  test("lane, role and subagent-type shares carry this week, the previous week and the delta", async () => {
    const r = await week();
    expect(r.from).toBe("2026-10-19T00:00:00.000Z");
    expect(r.previous).toMatchObject({ week: "2026-W42", hasWindowData: true });
    expect(r.tables.lane.map((x) => x.key)).toEqual(["worker", "interactive", "subagent"]);
    expect(row(r.tables.lane, "worker")).toEqual({
      key: "worker",
      fiveHour: { now: 16, prev: 5, delta: 11 },
      sevenDay: { now: 4, prev: 1.5, delta: 2.5 },
      sessions: 4, // s1, s2 and the two unattributed s5, s6
    });
    expect(row(r.tables.lane, "interactive")).toMatchObject({ fiveHour: { now: 6, prev: 5, delta: 1 }, sevenDay: { now: 2, prev: 1.5, delta: 0.5 } });
    expect(row(r.tables.lane, "subagent")).toMatchObject({ fiveHour: { now: 4, prev: 0, delta: 4 }, sevenDay: { now: 2, prev: 0, delta: 2 } });
    expect(row(r.tables.role, "worker")).toMatchObject({ fiveHour: { now: 16, prev: 5 }, sevenDay: { now: 4, prev: 1.5 }, sessions: 4 });
    expect(row(r.tables.role, "(none)")).toMatchObject({ fiveHour: { now: 10, prev: 5 }, sevenDay: { now: 4, prev: 1.5 }, sessions: 3 });
    expect(row(r.tables.lane, "subagent")?.sessions).toBe(2);
    expect(row(r.tables.subagentType, "Explore")).toMatchObject({ fiveHour: { now: 4 }, sevenDay: { now: 2 }, sessions: 2 });
    expect(row(r.tables.subagentType, "(none)")).toMatchObject({ fiveHour: { now: 22 }, sevenDay: { now: 6 }, sessions: 5 });
    const top1 = await weeklyReport(await db.sql(), { week: "2026-W43", top: 1 });
    expect(top1.tables.lane.map((x) => x.key)).toEqual(["worker"]);
    expect(top1.tables.topSessions.map((s) => s.session)).toEqual(["s1-aaaaa"]); // --top reaches the sessions table too
  });

  test("top sessions by 7d share, ties broken by 5h, ids shortened", async () => {
    const r = await week();
    expect(r.tables.topSessions.map((s) => [s.session, s.fiveHourPts, s.sevenDayPts])).toEqual([
      ["s1-aaaaa", 12, 3],
      ["s3-aaaaa", 6, 2],
      ["s3-aaaaa:agent-", 4, 2],
      ["s2-aaaaa", 4, 1],
    ]);
    expect(r.tables.topSessions).toHaveLength(4); // the unattributed s5, s6, s7 are not listed
    expect(r.tables.topSessions[0]).toMatchObject({ lane: "worker", role: "worker", repo: "r1", issue: "EP-1", model: "opus-5-5", effort: "high", account: "a" });
  });

  test("cache ratio comes from sums, compactions by event, with previous-week deltas", async () => {
    const r = await week();
    const worker = r.tables.cache.find((c) => c.lane === "worker");
    expect(worker?.requests).toBe(2);
    expect(worker?.cacheHitRatio.now).toBeCloseTo(1400 / 1700, 4); // not the mean of 0.8 and 0.857
    expect(worker?.cacheHitRatio.prev).toBeCloseTo(0.7, 4);
    expect(worker?.cacheHitRatio.delta).toBeCloseTo(1400 / 1700 - 0.7, 4);
    expect(worker?.compactions).toEqual({ now: 2, prev: 0, delta: 2 });
    expect(worker).toMatchObject({ sessions: 4, compactionsPerSession: 0.5 });
    expect(r.tables.cache.find((c) => c.lane === "interactive")?.cacheHitRatio.now).toBeCloseTo(0.98, 4);
    expect(r.tables.cache.find((c) => c.lane === "interactive")?.compactions.now).toBe(1);
    expect(r.tables.cache.find((c) => c.lane === "subagent")?.cacheHitRatio.now).toBeCloseTo(0.5, 4);
  });

  test("skills are loads and characters, newest against previous week", async () => {
    const r = await week();
    expect(r.tables.skills.map((s) => s.name)).toEqual(["(other)", "wave", "rare", "small"]);
    expect(r.tables.skills[0]).toMatchObject({ name: "(other)", loads: { now: 6, prev: 0, delta: 6 }, totalChars: { now: 105_000 }, avgChars: { now: 17_500, prev: null } });
    expect(r.tables.skills[1]).toEqual({
      name: "wave",
      loads: { now: 3, prev: 3, delta: 0 },
      totalChars: { now: 36_000, prev: 27_000, delta: 9000 },
      avgChars: { now: 12_000, prev: 9000, delta: 3000 },
    });
    expect(formatWeekly(r)).toContain("Skills have no window share");
  });

  test("verdict, coverage and the week-over-week change of the totals", async () => {
    const r = await week();
    expect(r.coverage).toEqual([
      { win: "five_hour", movedPts: 26, attributedPts: 26, residualPts: 0, residualPct: 0, prevMovedPts: 10 },
      { win: "seven_day", movedPts: 10, attributedPts: 8, residualPts: 2, residualPct: 20, prevMovedPts: 3 },
    ]);
    expect(r.verdict.topLane).toEqual({ lane: "worker", sevenDayShare: 50, fiveHourShare: 61.5 });
    expect(r.verdict.weekOverWeek).toEqual({ fiveHourPct: 160, sevenDayPct: 233.3 });
    expect(r.verdict.lines[0]).toContain("5h windows moved 26.0 points (26.0 attributed, 0.0% residual)");
    expect(r.verdict.lines[0]).toContain("7d windows 10.0 points (8.0 attributed, 20.0% residual)");
    expect(r.verdict.lines[1]).toContain("Top lane: worker with 50.0%");
    expect(r.verdict.lines[1]).toContain("5h +160.0% (10.0 -> 26.0), 7d +233.3% (3.0 -> 10.0)");
    const md = formatWeekly(r);
    expect(md.indexOf("## Verdict")).toBeLessThan(md.indexOf("## Share of the windows"));
    expect(md).toContain("The 7-day meter moves in whole points");
    expect(md).not.toMatch(/\|-{2,}/); // minimum separators
    expect(md).not.toMatch(/[┌┬─│└┘├┤┼]/);
  });

  test("without window data the previous week gives no delta and the verdict says so", async () => {
    const sql = await db.sql();
    const r = await weeklyReport(sql, { week: "2026-W42", thresholds: th }); // W41 has no quota readings
    expect(r.previous.hasWindowData).toBe(false);
    expect(r.verdict.weekOverWeek).toBeNull();
    expect(r.verdict.lines[1]).toContain("No window data in 2026-W41, so no week-over-week change.");
    expect(r.tables.lane.every((l) => l.fiveHour.prev === null && l.fiveHour.delta === null)).toBe(true);
    expect(formatWeekly(r)).toContain("no quota readings there: no delta");
  });

  test("every rule fires once and one of its candidates stays quiet", async () => {
    const r = await week();
    expect(r.findings.map((f) => f.id)).toEqual([
      "skill-size:wave", // small (avg 1k) and rare (1 load) stay quiet
      "subagent-effort:Explore",
      "role-tier:worker", // interactive has no Sonnet session; the worker lane shares the id with the role
      "compaction-rate:worker", // interactive: 1 session < 2
      "cache-ratio:worker", // interactive 0.98; subagent is no main lane
    ]);
    const byId = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(byId["skill-size:wave"]?.metric).toEqual({ name: "avg_size_chars", value: 12_000, unit: "chars" });
    expect(byId["subagent-effort:Explore"]?.metric.value).toBe(1); // 2 points over 2 sessions, one of them unattributed
    expect(byId["subagent-effort:Explore"]?.claim).toContain("ran 2 sessions");
    expect(byId["role-tier:worker"]?.metric).toEqual({ name: "opus_vs_sonnet_mean_7d_ratio", value: 3, unit: "x" });
    expect(byId["role-tier:worker"]?.claim).toContain("its 2 Opus sessions averaged 1.50 points of the 7d window against 0.50 for 2 Sonnet sessions");
    expect(byId["role-tier:worker"]?.proposal).toContain("software-factory config/roles.json");
    expect(byId["compaction-rate:worker"]?.metric).toEqual({ name: "compactions_per_session", value: 0.5, unit: "per session" });
    expect(r.findings.some((f) => f.id.includes("(other)") || f.id.includes("example"))).toBe(false);
    expect(byId["cache-ratio:worker"]?.metric.value).toBeCloseTo(0.8235, 4);
    for (const f of r.findings) {
      expect(f.id).toBe(`${f.rule}:${f.subject}`);
      expect(f.claim).toMatch(/\d/);
      expect(f.proposal.length).toBeGreaterThan(10);
    }
  });

  test("finding ids are stable across weeks: recurring with the effect, new, and resolved with the last value", async () => {
    const r = await week();
    const wave = r.findings.find((f) => f.id === "skill-size:wave");
    expect(wave?.trend).toEqual({ status: "recurring", prev: 9000, delta: 3000 });
    expect(r.findings.find((f) => f.id === "cache-ratio:worker")?.trend).toMatchObject({ status: "recurring", prev: 0.7 });
    expect(r.findings.find((f) => f.id === "compaction-rate:worker")?.trend).toEqual({ status: "new" });
    expect(r.resolved.map((x) => [x.id, x.metric.value])).toEqual([["skill-size:old", 10_000]]);
    const md = formatWeekly(r);
    expect(md).toContain("avg_size_chars: 9000 -> 12000 chars (+3000)");
    expect(md).toContain("compactions_per_session: new (0.5 per session)");
    expect(md).toContain("**skill-size:old**: gone since 2026-W42; last value 10000 chars");
    expect(r.verdict.lines[2]).toBe("5 findings (3 new, 2 recurring), 1 resolved since 2026-W42.");
  });

  test("the production thresholds are the documented ones and keep a small week quiet", async () => {
    expect(FINDING_THRESHOLDS).toEqual({
      skillSize: { minLoads: 20, minAvgChars: 8000 },
      subagentEffort: { minSessions: 10, topRank: 3 },
      roleTier: { minShare: 0.2, minSpawnsPerModel: 5, minRatio: 2 },
      compactionRate: { minSessions: 5, minPerSession: 0.5 },
      cacheRatio: { maxRatio: 0.9, minRequests: 200 },
    });
    const r = await week(FINDING_THRESHOLDS);
    expect(r.findings).toEqual([]);
    expect(r.resolved).toEqual([]);
  });

  test("an empty week is a valid short report, not a crash", async () => {
    const sql = await db.sql();
    const r = await weeklyReport(sql, { week: "2030-W10" });
    expect(r.empty).toBe(true);
    expect(r.verdict.lines).toEqual(["No window data and no signals in 2030-W10 (2030-03-04 to 2030-03-11 UTC): nothing to report."]);
    expect(r.tables.lane).toEqual([]);
    const md = formatWeekly(r);
    expect(md).toContain("nothing to report");
    expect(md.split("\n").length).toBeLessThan(15);
    expect(JSON.parse(JSON.stringify(r)).findings).toEqual([]);
  });

  test("the default week is derived from now", async () => {
    const r = await weeklyReport(await db.sql(), { now: NOW, thresholds: th });
    expect(r.week).toBe("2026-W43");
    expect(r.tables.lane.length).toBe(3);
  });

  test("readings without movement are a measured zero; a week without readings is unknown", async () => {
    const sql = await db.sql();
    const flat = await weeklyReport(sql, { week: "2026-W39", thresholds: th }); // account z: two equal readings, W38 the same
    expect(flat.hasWindowData).toBe(true);
    expect(flat.previous.hasWindowData).toBe(true);
    expect(flat.coverage[0]).toEqual({ win: "five_hour", movedPts: 0, attributedPts: 0, residualPts: 0, residualPct: null, prevMovedPts: 0 });
    expect(flat.verdict.weekOverWeek).toEqual({ fiveHourPct: null, sevenDayPct: null }); // measured, but 0 -> 0 has no percentage
    const none = await weeklyReport(sql, { week: "2026-W40", thresholds: th });
    expect(none.hasWindowData).toBe(false);
    expect(none.coverage[0]).toEqual({ win: "five_hour", movedPts: null, attributedPts: null, residualPts: null, residualPct: null, prevMovedPts: 0 });
    expect(formatWeekly(none)).toContain("No quota readings in the week");
  });

  test("a week without Claude Code records or readings leaves last week's findings unknown, not resolved; md and json agree", async () => {
    const sql = await db.sql();
    const r = await weeklyReport(sql, { week: "2026-W44", thresholds: th });
    expect(r.empty).toBe(true);
    // No Claude Code record in W44 (ingest down or a quiet week): nothing of W43's can be called resolved.
    expect(r.hasClaudeData).toBe(false);
    expect(r.resolved).toEqual([]);
    expect(r.unknown.map((x) => x.id)).toEqual(["skill-size:wave", "subagent-effort:Explore", "role-tier:worker", "compaction-rate:worker", "cache-ratio:worker"]);
    const md = formatWeekly(r);
    const json = JSON.parse(JSON.stringify(r));
    expect(md).toContain("### Unknown (not measured this week)");
    for (const x of [...json.resolved, ...json.unknown]) expect(md).toContain(`**${x.id}**`);
    expect(r.verdict.lines[1]).toContain("0 resolved, 5 unknown");

    // The same week with a session but still no readings: not empty, window figures unknown, same split of findings.
    await sql`INSERT INTO usage.sessions (source, source_session_id, lane, first_ts, last_ts)
              VALUES ('claude-code', 'q1', 'worker', ${at(T + 7 * 86_400_000, 1)}, ${at(T + 7 * 86_400_000, 2)})`;
    try {
      const busy = await weeklyReport(sql, { week: "2026-W44", thresholds: th });
      expect(busy.empty).toBe(false);
      expect(busy.hasWindowData).toBe(false);
      expect(busy.verdict.lines[0]).toContain("no quota readings in the week, so the window figures are unknown");
      expect(busy.tables.lane).toEqual([{ key: "worker", fiveHour: { now: null, prev: null, delta: null }, sevenDay: { now: null, prev: null, delta: null }, sessions: 1 }]);
      expect(busy.unknown).toHaveLength(5);
      expect(busy.resolved).toEqual([]);
      expect(busy.verdict.lines.join("\n")).toContain("No Claude Code records in 2026-W44");
      expect(formatWeekly(busy)).toContain("### Unknown (not measured this week)");
    } finally {
      await sql`DELETE FROM usage.sessions WHERE source_session_id = 'q1'`;
    }
  });

  test("trackFindings: what a week cannot measure is unknown or unmeasured, never resolved or new", () => {
    const f = (id: string, rule: string): RawFinding => ({ id, rule, subject: id.split(":")[1] as string, claim: "c 1", proposal: "p", metric: { name: "m", value: 1, unit: "u" } });
    const win = f("role-tier:x", "role-tier");
    const cache = f("cache-ratio:worker", "cache-ratio");
    const ok = { claude: true, sevenDay: true };
    const status = (now: RawFinding[], prev: RawFinding[], cur: typeof ok, before: typeof ok) =>
      trackFindings(now, prev, { cur, prev: before });
    // last week not measured: present findings are unmeasured, per rule
    expect(status([win, cache], [], ok, { claude: true, sevenDay: false }).findings.map((x) => x.trend.status)).toEqual(["unmeasured", "new"]);
    expect(status([win, cache], [], ok, { claude: false, sevenDay: true }).findings.map((x) => x.trend.status)).toEqual(["unmeasured", "unmeasured"]);
    expect(status([win, cache], [], ok, ok).findings.map((x) => x.trend.status)).toEqual(["new", "new"]);
    // this week not measured: gone findings are unknown, per rule
    const noSeven = status([], [win, cache], { claude: true, sevenDay: false }, ok);
    expect([noSeven.resolved.map((x) => x.id), noSeven.unknown.map((x) => x.id)]).toEqual([["cache-ratio:worker"], ["role-tier:x"]]);
    const noClaude = status([], [win, cache], { claude: false, sevenDay: true }, ok);
    expect([noClaude.resolved.length, noClaude.unknown.length]).toEqual([0, 2]);
    expect(status([], [win, cache], ok, ok).resolved).toHaveLength(2);
  });

  test("window availability is per window: a 5h-only week has no 7d figures, and a pct without resets_at is no reading", async () => {
    const sql = await db.sql();
    const r = await weeklyReport(sql, { week: "2026-W36", thresholds: th });
    expect(r.windowReadings).toEqual({ fiveHour: true, sevenDay: false });
    expect(r.hasWindowData).toBe(true);
    expect(r.previous.windowReadings).toEqual({ fiveHour: true, sevenDay: true }); // W35: account x
    expect(r.coverage[0]).toEqual({ win: "five_hour", movedPts: 4, attributedPts: 4, residualPts: 0, residualPct: 0, prevMovedPts: 6 });
    expect(r.coverage[1]).toEqual({ win: "seven_day", movedPts: null, attributedPts: null, residualPts: null, residualPct: null, prevMovedPts: 0 });
    expect(r.tables.lane).toEqual([
      { key: "worker", fiveHour: { now: 4, prev: 0, delta: 4 }, sevenDay: { now: null, prev: null, delta: null }, sessions: 1 },
    ]);
    expect(r.verdict.weekOverWeek).toEqual({ fiveHourPct: -33.3, sevenDayPct: null });
    expect(r.verdict.lines[0]).toContain("the 5h windows moved 4.0 points (4.0 attributed, 0.0% residual), the 7d windows have no readings (unknown)");
    expect(r.verdict.lines[1]).toContain("Top lane: worker with 100.0% of the attributed 5h points (7d unknown)");
    expect(r.verdict.lines[1]).toContain("Week over week: 5h -33.3% (6.0 -> 4.0).");
    expect(formatWeekly(r)).toContain("7d has no readings (unknown, not zero)");
  });

  test("attribution without a session keeps its points in the totals but is no session", async () => {
    const sql = await db.sql();
    const r = await weeklyReport(sql, { week: "2026-W35", thresholds: th });
    expect(r.coverage[0]).toMatchObject({ movedPts: 6, attributedPts: 6 });
    expect(r.tables.lane).toEqual([
      { key: "(no session)", fiveHour: { now: 6, prev: null, delta: null }, sevenDay: { now: 0, prev: null, delta: null }, sessions: 0 },
    ]);
    expect(r.tables.role[0]).toMatchObject({ key: "(none)", sessions: 0, fiveHour: { now: 6 } });
    expect(r.tables.topSessions).toEqual([]);
    expect(r.verdict.topLane).toBeNull();
    expect(r.verdict.lines[1]).toContain("No lane has attributed window movement from a known session.");
  });

  test("hostile skill names never reach the report", async () => {
    const r = await week();
    const md = formatWeekly(r);
    const json = JSON.stringify(r);
    for (const text of [md, json]) for (const name of ["example.com", "10.0.0.1", "op://x/y", "a@b.c", "b.c"]) expect(text).not.toContain(name);
    expect(r.tables.skills.find((x) => x.name === "(other)")?.loads.now).toBe(6);
  });

  test("the report carries no address, URL or secret reference, even when the data does", async () => {
    const r = await week();
    const md = formatWeekly(r);
    const json = JSON.stringify(r);
    for (const text of [md, json]) {
      expect(text).not.toContain("@");
      expect(text).not.toContain("http");
      expect(text).not.toContain("op://");
    }
    expect(md).toContain("(address)"); // repo "ops@example.com"
    expect(md).toContain("(ref)"); // issue "op://vault/item"
  });

  test("--out tightens a reports directory that already existed", async () => {
    const report = await week();
    const base = mkdtempSync(join(tmpdir(), "weekly-"));
    const dir = join(base, "reports");
    try {
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
      writeWeekly(dir, report);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--out writes markdown and JSON atomically beside each other", async () => {
    const r = await week();
    const dir = join(mkdtempSync(join(tmpdir(), "weekly-")), "reports");
    try {
      const paths = writeWeekly(dir, r);
      expect(paths.map((p) => p.slice(dir.length + 1))).toEqual(["2026-W43.md", "2026-W43.json"]);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const p of paths) expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).sort()).toEqual(["2026-W43.json", "2026-W43.md"]); // no temp file left
      expect(readFileSync(paths[0] as string, "utf8")).toBe(formatWeekly(r));
      expect(JSON.parse(readFileSync(paths[1] as string, "utf8")).week).toBe("2026-W43");
      expect(Object.keys(JSON.parse(readFileSync(paths[1] as string, "utf8")))).toEqual(
        expect.arrayContaining(["week", "from", "to", "verdict", "tables", "findings", "coverage"]),
      );
      writeWeekly(dir, r); // overwrite
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});
