import { beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { migratedDb } from "./fixture.ts";
import { describePg } from "./testing.ts";

// Expected numbers are computed by hand from this fixture (source claude-code, times UTC).
//
//   records (session, record lane, time)             input  read  write5m  write1h  output
//   rA1 sA  interactive  10-29 23:50                    60   300     100        0      10
//   rA2 sA  interactive  10-30 00:10                    40   400      50       50      20
//   rB1 sB  interactive  10-30 09:00                   400   100       0        0       5
//   rB3 sB  subagent     10-30 09:30  (a subagent request inside an interactive session)
//                                                      100   400       0        0       7
//   rC1 sC  subagent     10-30 10:00  (all zero)         0     0       0        0       0
//   rD  sB  lead         10-30 09:10  1000 of every kind, flagged in record_duplicates (a gateway-mirror copy of rB1): it
//       counts in neither view. Were it counted, sB would be input 1500 / ratio 1500 / 4500 and lane `lead` 10-30 would exist.
//
//   events: sA compaction 10-30 11:00 and 10-31 00:00:10 | sA skill a1 10-30 09:30 size 300, skill a2 10-30 09:40 no size
//           sC ("sA:ag1", a subagent) skill c1 10-30 10:05 size 1000 | sD skill d1 10-31 08:00 size 400 (sD has no records)
//           source 'codex' compaction in a session also called sA (another source: must not count)
//   sE: no records, no events.
//
// session_signals
//   sA: input 60+40 = 100, read 700, write5m 150, write1h 50, output 30 -> ratio 700 / (100+700+150+50) = 0.7
//       compactions 2, skill_calls 2, skill_chars 300 (the call without a size adds a call, not chars)
//   sB: input 400+100 = 500, read 100+400 = 500, no writes -> ratio 500 / 1000 = 0.5; no events: 0, 0, 0
//   sC: all tokens 0 -> denominator 0 -> ratio NULL; parent = sA; skill_calls 1, skill_chars 1000
//   sD: no records -> tokens 0, ratio NULL; skill_calls 1, skill_chars 400
//   sE: tokens 0, ratio NULL, 0, 0, 0
//
// lane_signals (by the RECORD's lane for tokens, by the session's lane for events)
//   interactive 10-29: read 300 / (60+300+100) = 300/460                      = 0.652173913...
//   interactive 10-30: input 40+400 = 440, read 400+100 = 500, write5m 50, write1h 50 -> 500 / 1040 = 0.480769...
//                      (the mean of the sessions' ratios, 0.7 and 0.5, is 0.6: a ratio is never averaged)
//                      compactions 1 (sA 11:00), skill_calls 2, skill_chars 300
//   subagent    10-30: input 100+0, read 400+0 -> 400 / 500 = 0.8 ; sC's skill call: skill_calls 1, skill_chars 1000
//   interactive 10-31: no records: tokens 0, ratio NULL; compactions 1 (sA 00:00:10)
//   worker      10-31: no records, only sD's skill: skill_calls 1, skill_chars 400
const T = (day: string, hms: string) => `2026-10-${day}T${hms}Z`;

describePg("usage.session_signals and usage.lane_signals", () => {
  const db = migratedDb();
  let sql: SQL;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    sql = await db.reset();
    const session = async (key: string, lane: string, parent?: string) => {
      const [row] = await sql`INSERT INTO usage.sessions (source, source_session_id, lane, parent_session_id, repo, effort)
                              VALUES ('claude-code', ${key}, ${lane}, ${parent ? ids[parent] ?? null : null}, 'usage-tracker', 'high') RETURNING id`;
      ids[key] = Number(row.id);
    };
    await session("sA", "interactive");
    await session("sB", "interactive");
    await session("sA:ag1", "subagent", "sA");
    await session("sD", "worker");
    await session("sE", "other");

    let n = 0;
    const record = (key: string, lane: string, at: string, input: number, read: number, w5: number, w1: number, output: number) =>
      sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, lane, input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, output_tokens)
          VALUES ('claude-code', ${`r${++n}`}, 'message', ${at}, ${ids[key]}, ${lane}, ${input}, ${read}, ${w5}, ${w1}, ${output})`;
    await record("sA", "interactive", T("29", "23:50:00"), 60, 300, 100, 0, 10);
    await record("sA", "interactive", T("30", "00:10:00"), 40, 400, 50, 50, 20);
    await record("sB", "interactive", T("30", "09:00:00"), 400, 100, 0, 0, 5);
    await record("sB", "subagent", T("30", "09:30:00"), 100, 400, 0, 0, 7);
    await record("sA:ag1", "subagent", T("30", "10:00:00"), 0, 0, 0, 0, 0);
    await record("sB", "lead", T("30", "09:10:00"), 1000, 1000, 1000, 1000, 1000);
    await sql`INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
              SELECT d.id, o.id, 'gateway-mirror' FROM usage.records d, usage.records o WHERE d.source_id = 'r6' AND o.source_id = 'r3'`;

    const event = (source: string, id: string, key: string, kind: string, at: string, size: number | null) =>
      sql`INSERT INTO usage.session_events (source, event_id, source_session_id, kind, ts, size_chars)
          VALUES (${source}, ${id}, ${key}, ${kind}, ${at}, ${size})`;
    await event("claude-code", "cb1", "sA", "compaction", T("30", "11:00:00"), null);
    await event("claude-code", "cb2", "sA", "compaction", T("31", "00:00:10"), null);
    await event("claude-code", "a1", "sA", "skill", T("30", "09:30:00"), 300);
    await event("claude-code", "a2", "sA", "skill", T("30", "09:40:00"), null);
    await event("claude-code", "c1", "sA:ag1", "skill", T("30", "10:05:00"), 1000);
    await event("claude-code", "d1", "sD", "skill", T("31", "08:00:00"), 400);
    await event("codex", "x1", "sA", "compaction", T("30", "12:00:00"), null);
  });

  const sessionRow = async (key: string) => {
    const [r] = await sql`SELECT * FROM usage.session_signals WHERE source = 'claude-code' AND source_session_id = ${key}`;
    return r as Record<string, unknown>;
  };
  const counts = (r: Record<string, unknown>) => [r.compactions, r.skill_calls, Number(r.skill_chars)];
  const tokens = (r: Record<string, unknown>) =>
    [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens].map(Number);

  test("a record flagged as a duplicate contributes to neither view", async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.record_duplicates`;
    expect(n).toBe(1);
    const b = await sessionRow("sB");
    expect(tokens(b)).toEqual([500, 12, 500, 0, 0]);
    expect((await lane()).has("lead 2026-10-30")).toBe(false);
  });

  test("one row per session with its attributes", async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.session_signals`;
    expect(n).toBe(5);
    const r = await sessionRow("sA:ag1");
    expect(r).toMatchObject({ lane: "subagent", repo: "usage-tracker", effort: "high" });
    expect(Number(r.parent_session_id)).toBe(ids.sA as number);
  });

  test("cache hit ratio = cache_read / (input + cache_read + write5m + write1h); NULL when the denominator is 0", async () => {
    const a = await sessionRow("sA");
    expect(tokens(a)).toEqual([100, 30, 700, 150, 50]);
    expect(a.cache_hit_ratio).toBeCloseTo(0.7, 12);
    expect((await sessionRow("sB")).cache_hit_ratio).toBeCloseTo(0.5, 12);
    for (const key of ["sA:ag1", "sD", "sE"]) expect((await sessionRow(key)).cache_hit_ratio).toBeNull();
  });

  test("compactions, skill calls and skill chars per session; 0 and not NULL when there are none; another source does not count", async () => {
    expect(counts(await sessionRow("sA"))).toEqual([2, 2, 300]);
    expect(counts(await sessionRow("sB"))).toEqual([0, 0, 0]);
    expect(counts(await sessionRow("sA:ag1"))).toEqual([0, 1, 1000]);
    expect(counts(await sessionRow("sD"))).toEqual([0, 1, 400]);
    expect(counts(await sessionRow("sE"))).toEqual([0, 0, 0]);
  });

  const lane = async () => {
    const rows = (await sql`SELECT lane, day::text AS day, input_tokens, cache_read_tokens, cache_hit_ratio, compactions, skill_calls, skill_chars
                            FROM usage.lane_signals WHERE source = 'claude-code' ORDER BY day, lane`) as Record<string, unknown>[];
    return new Map(rows.map((r) => [`${r.lane} ${r.day}`, r]));
  };

  test("lane_signals groups records by the record's lane and UTC day, the ratio from the sums", async () => {
    const m = await lane();
    expect([...m.keys()]).toEqual(["interactive 2026-10-29", "interactive 2026-10-30", "subagent 2026-10-30", "interactive 2026-10-31", "worker 2026-10-31"]);
    expect(m.get("interactive 2026-10-29")?.cache_hit_ratio).toBeCloseTo(300 / 460, 12);
    const i30 = m.get("interactive 2026-10-30");
    expect([Number(i30?.input_tokens), Number(i30?.cache_read_tokens)]).toEqual([440, 500]);
    expect(i30?.cache_hit_ratio).toBeCloseTo(500 / 1040, 12);
    expect(i30?.cache_hit_ratio).not.toBeCloseTo(0.6, 2);
    expect(m.get("subagent 2026-10-30")?.cache_hit_ratio).toBeCloseTo(0.8, 12);
  });

  test("lane_signals counts events for the lane of their session, and an events-only lane/day still appears", async () => {
    const m = await lane();
    expect(counts(m.get("interactive 2026-10-30") as Record<string, unknown>)).toEqual([1, 2, 300]);
    expect(counts(m.get("subagent 2026-10-30") as Record<string, unknown>)).toEqual([0, 1, 1000]);
    const i31 = m.get("interactive 2026-10-31") as Record<string, unknown>;
    expect(counts(i31)).toEqual([1, 0, 0]);
    expect(i31.cache_hit_ratio).toBeNull();
    const w31 = m.get("worker 2026-10-31") as Record<string, unknown>;
    expect(counts(w31)).toEqual([0, 1, 400]);
    expect([Number(w31.input_tokens), w31.cache_hit_ratio]).toEqual([0, null]);
  });
});
