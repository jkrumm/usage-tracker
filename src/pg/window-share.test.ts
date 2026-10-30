import { beforeAll, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { migratedDb } from './fixture.ts'
import { describePg } from './testing.ts'

// Expected shares are computed by hand from this fixture (account a, 2026-10-30, times UTC, five-hour window unless noted):
//
//   reading  five%  resets   seven%
//   10:00     10    12:00     20
//   10:15     14    12:00     20      -> interval (10:00,10:15] moves 4
//   10:30     20    12:00     22      -> (10:15,10:30] moves 6; seven-day moves 2
//   12:15      5    17:00     22      -> new window: baseline 0, moves 5, records after the old end 12:00 only
//   12:30      5    17:00:30  22      -> jitter of 30 s is the same window, delta 0
//   13:00      8    17:00:30  22      -> (12:30,13:00] moves 3 with no record: residual
//
//   records (cost): s1 10:05 $1, 10:20 $2 | s2 10:10 $3, 10:25 $2 | s3 12:10 $4 | s4 11:59 $9 (old window's tail)
//                   s6 10:12 NULL cost | account b: 10:10 $100 (other account)
//
//   (10:00,10:15]  4 over s1 $1, s2 $3        -> s1 1, s2 3
//   (10:15,10:30]  6 over s1 $2, s2 $2        -> s1 3, s2 3 ; seven-day 2 -> s1 1, s2 1
//   (12:00,12:15]  5 over s3 $4               -> s3 5
//   five_hour: s1 4, s2 6, s3 5 (sum 15 = 4 + 6 + 5) ; s4 nothing ; seven_day: s1 1, s2 1
//
// Account c: a reading without the five-hour pct between two that have it (10 -> NULL -> 20) still moves the window 10.
// Account d: two resets between readings (10:00 at 50 %, resets 12:00 | 17:30 at 8 %, resets 22:00): the window that
//   produced the 8 points began at 17:00, so a $5 record at 14:00 gets nothing and the $2 record at 17:10 gets all 8.
// Account e: two machines read at 10:30, the alphabetically first has no pct, the second has 6: the complete one counts.
const T = (hm: string) => `2026-10-30T${hm}:00Z`

describePg('usage.session_window_share', () => {
  const db = migratedDb()
  let sql: SQL
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    sql = await db.reset()
    const reading = (
      account: string,
      at: string,
      five: number,
      fiveResets: string,
      seven: number,
    ) =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES (${account}, ${T(at)}, 'mini', ${five}, ${seven}, ${fiveResets}, '2026-11-05T06:00:00Z')`
    await reading('a', '10:00', 10, T('12:00'), 20)
    await reading('a', '10:15', 14, T('12:00'), 20)
    await reading('a', '10:30', 20, T('12:00'), 22)
    await reading('a', '12:15', 5, T('17:00'), 22)
    await reading('a', '12:30', 5, '2026-10-30T17:00:30Z', 22)
    await reading('a', '13:00', 8, '2026-10-30T17:00:30Z', 22)
    await reading('b', '10:00', 0, T('12:00'), 0)
    await reading('b', '10:15', 50, T('12:00'), 9)

    const wide = (
      account: string,
      machine: string,
      at: string,
      five: number | null,
      fiveResets: string | null,
    ) =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES (${account}, ${T(at)}, ${machine}, ${five}, 0, ${fiveResets}, '2026-11-05T06:00:00Z')`
    await wide('c', 'mini', '10:00', 10, T('12:00'))
    await wide('c', 'mini', '10:15', null, null)
    await wide('c', 'mini', '10:30', 20, T('12:00'))
    await wide('d', 'mini', '10:00', 50, T('12:00'))
    await wide('d', 'mini', '17:30', 8, T('22:00'))
    await wide('e', 'mini', '10:00', 0, T('12:00'))
    await wide('e', 'aaa', '10:30', null, null)
    await wide('e', 'zzz', '10:30', 6, T('12:00'))

    for (const s of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11']) {
      const [row] =
        await sql`INSERT INTO usage.sessions (source, source_session_id, lane) VALUES ('claude-code', ${s}, 'interactive') RETURNING id`
      ids[s] = Number(row.id)
    }
    let n = 0
    const record = (session: string, account: string, at: string, cost: number | null) =>
      sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, billing, account, cost_usd)
          VALUES ('claude-code', ${`r${++n}`}, 'message', ${T(at)}, ${ids[session]}, 'max', ${account}, ${cost})`
    await record('s1', 'a', '10:05', 1)
    await record('s1', 'a', '10:20', 2)
    await record('s2', 'a', '10:10', 3)
    await record('s2', 'a', '10:25', 2)
    await record('s3', 'a', '12:10', 4)
    await record('s4', 'a', '11:59', 9)
    await record('s6', 'a', '10:12', null)
    await record('s5', 'b', '10:10', 100)
    await record('s7', 'c', '10:20', 4)
    await record('s8', 'd', '14:00', 5)
    await record('s9', 'd', '17:10', 2)
    await record('s10', 'e', '10:20', 1)
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, billing, account, cost_usd)
              VALUES ('claude-code', 'sessionless', 'message', ${T('10:25')}, 'max', 'c', 4)`
  })

  const shares = async (account: string) => {
    const rows =
      await sql`SELECT session_id, five_hour_pct::float8 AS five, seven_day_pct::float8 AS seven
                           FROM usage.session_window_share WHERE account = ${account}`
    return new Map(
      rows.map((r: Record<string, unknown>) => [
        Number(r.session_id),
        { five: r.five as number, seven: r.seven as number },
      ]),
    )
  }

  test('the delta of each interval is split by cost over the sessions inside it', async () => {
    const a = await shares('a')
    expect(a.size).toBe(3)
    expect(a.get(ids.s1 as number)).toEqual({ five: 4, seven: 1 })
    expect(a.get(ids.s2 as number)).toEqual({ five: 6, seven: 1 })
    expect(a.get(ids.s3 as number)).toEqual({ five: 5, seven: 0 })
  })

  test("a window that restarted counts from zero and ignores records of the old window's tail; jitter is not a restart", async () => {
    const intervals =
      await sql`SELECT to_at, delta_pct::float8 AS delta, fresh_window, records_n::int AS n
                                FROM usage.window_intervals WHERE account = 'a' AND win = 'five_hour' ORDER BY to_at`
    expect(
      intervals.map((i: Record<string, unknown>) => [
        new Date(i.to_at as string).toISOString().slice(11, 16),
        i.delta,
        i.fresh_window,
        i.n,
      ]),
    ).toEqual([
      ['10:15', 4, false, 3],
      ['10:30', 6, false, 2],
      ['12:15', 5, true, 1],
      ['13:00', 3, false, 0],
    ])
  })

  test('a window that moved with no record is residual, never attributed', async () => {
    const [{ moved, attributed }] = await sql`
      SELECT (SELECT sum(delta_pct) FROM usage.window_intervals WHERE account = 'a' AND win = 'five_hour')::float8 AS moved,
             (SELECT sum(share_pct) FROM usage.window_attribution WHERE account = 'a' AND win = 'five_hour')::float8 AS attributed`
    expect(moved).toBe(18)
    expect(attributed).toBe(15)
    const [{ residual }] = await sql`
      SELECT sum(delta_pct)::float8 AS residual FROM usage.window_intervals WHERE account = 'a' AND win = 'five_hour' AND records_cost = 0`
    expect(residual).toBe(3)
  })

  test('accounts do not leak into each other', async () => {
    const b = await shares('b')
    expect([...b.values()]).toEqual([{ five: 50, seven: 9 }])
    expect([...b.keys()]).toEqual([ids.s5 as number])
  })

  test("a reading missing a window's pct does not lose that window's movement across the gap", async () => {
    const [{ moved }] =
      await sql`SELECT sum(delta_pct)::float8 AS moved FROM usage.window_intervals WHERE account = 'c' AND win = 'five_hour'`
    expect(moved).toBe(10)
    // The record without a session takes its half of the points, under a NULL session.
    const rows =
      await sql`SELECT session_id, five_hour_pct::float8 AS five FROM usage.session_window_share WHERE account = 'c' ORDER BY session_id NULLS LAST`
    expect(
      rows.map((r: Record<string, unknown>) => [
        r.session_id === null ? null : Number(r.session_id),
        r.five,
      ]),
    ).toEqual([
      [ids.s7, 5],
      [null, 5],
    ])
  })

  test("with several resets between readings only the current window's own span can be blamed", async () => {
    const d = await shares('d')
    expect([...d.entries()]).toEqual([[ids.s9 as number, { five: 8, seven: 0 }]])
  })

  test('of two machines reading at the same instant the complete reading counts', async () => {
    const e = await shares('e')
    expect([...e.values()]).toEqual([{ five: 6, seven: 0 }])
  })
})
