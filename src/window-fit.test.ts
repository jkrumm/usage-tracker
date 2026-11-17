import { beforeAll, expect, test } from 'bun:test'
import { migratedDb } from './pg/fixture.ts'
import { describePg } from './pg/testing.ts'
import { fitBins, fitWeights, formatFit, solve } from './window-fit.ts'

test('least squares through the origin recovers exact weights and refuses collinear columns', () => {
  const bins = [
    { y: 2 * 1 + 3 * 2, x: [1, 2] },
    { y: 2 * 3 + 3 * 1, x: [3, 1] },
    { y: 2 * 2 + 3 * 5, x: [2, 5] },
  ]
  const b = solve(bins, 2) as number[]
  expect(b[0]).toBeCloseTo(2, 9)
  expect(b[1]).toBeCloseTo(3, 9)
  expect(
    solve(
      [
        { y: 1, x: [1, 2] },
        { y: 2, x: [2, 4] },
      ],
      2,
    ),
  ).toBeNull()
})

test('the bootstrap is seeded: one input, one interval', () => {
  const bins = Array.from({ length: 30 }, (_, i) => ({ y: 2 * (i + 1) + (i % 3), x: [i + 1] }))
  const a = fitBins(bins, 1, { seed: 'x' })
  expect(fitBins(bins, 1, { seed: 'x' })).toEqual(a)
  expect(a.low[0] as number).toBeLessThan(2.05)
  expect(a.high[0] as number).toBeGreaterThan(1.95)
})

// One account, 80 intervals of 3 h, each a fresh 5 h window (its points are the whole reading, integers), each with a
// Max record per family. The true weights are known: sonnet 1.0, fable 5.0 and haiku 0.02 points per weighted Mtok.
describePg('window --fit (Postgres)', () => {
  const db = migratedDb()
  const T0 = Date.parse('2026-11-01T00:30:00Z')
  const HOUR = 3_600_000
  const TRUE = { sonnet: 1, fable: 5, haiku: 0.02 }
  const bound = { from: new Date('2026-10-31T00:00:00Z'), to: new Date('2026-11-20T00:00:00Z') }

  beforeAll(async () => {
    const sql = await db.reset()
    let seed = 7
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const models = {
      sonnet: 'claude-sonnet-5-5',
      fable: 'claude-fable-5-2',
      haiku: 'claude-haiku-5-5',
    }
    const reading = (at: number, pct: number) =>
      sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at)
          VALUES ('a', ${new Date(at).toISOString()}, 'mini', ${pct}, 0, ${new Date(at + 2 * HOUR).toISOString()}, '2099-01-01T00:00:00Z')`
    await reading(T0 - 3 * HOUR, 0)
    for (let n = 0; n < 80; n++) {
      const at = T0 + n * 3 * HOUR
      // every fourth stretch is quiet: little usage, the meter does not tick (0 points), an observation the fit must keep
      const quiet = n % 4 === 3
      const mtok = quiet
        ? { sonnet: 0.2, fable: 0.05, haiku: 0.1 }
        : { sonnet: 2 + rand() * 6, fable: rand() * 3, haiku: rand() * 6 }
      let pts = 0
      for (const f of ['sonnet', 'fable', 'haiku'] as const) {
        pts += TRUE[f] * mtok[f]
        // output tokens weigh 5: weighted Mtok = 5 x output / 1e6
        await sql`INSERT INTO usage.records (source, source_id, grain, ts, billing, account, lane, model, output_tokens)
            VALUES ('claude-code', ${`${f}-${n}`}, 'message', ${new Date(at - HOUR).toISOString()}, 'max', 'a', 'other', ${models[f]}, ${Math.round((mtok[f] * 1e6) / 5)})`
      }
      await reading(at, Math.round(pts))
    }
  })

  test('recovers the known weights inside the printed interval and calls the negligible family undetermined', async () => {
    const sql = await db.sql()
    const rows = await fitWeights(sql, { ...bound, account: 'a' })
    const five = rows.filter((r) => r.win === 'five_hour')
    const by = Object.fromEntries(five.map((r) => [r.family, r]))
    for (const f of ['sonnet', 'fable'] as const) {
      const r = by[f]
      expect(r?.determined).toBe(true)
      expect(r?.ptsPerMtok as number).toBeGreaterThan(TRUE[f] * 0.9)
      expect(r?.ptsPerMtok as number).toBeLessThan(TRUE[f] * 1.1)
      expect(r?.low as number).toBeLessThanOrEqual(TRUE[f])
      expect(r?.high as number).toBeGreaterThanOrEqual(TRUE[f])
    }
    expect(by.fable?.relativeToReference).toBeCloseTo(5, 0)
    expect(by.sonnet?.relativeToReference).toBe(1)
    expect(by.haiku?.determined).toBe(false)
    expect(by.haiku?.relativeToReference).toBeNull()
    expect(by.sonnet?.bins).toBe(80)
    const [quiet] =
      await sql`SELECT count(*)::int AS n FROM usage.window_quiet_intervals WHERE win = 'five_hour'`
    expect(quiet?.n).toBe(20)
    expect(by.sonnet?.weightedMtok as number).toBeGreaterThan(200)
    const text = formatFit(rows, { days: 7 })
    expect(text).toMatch(/haiku\s+not determined yet \(\d+(\.\d)? weighted Mtok\)/)
    expect(text).toContain('account a, 5h window')
  })

  test('is repeatable, honours the account and the period, and says so when there is nothing', async () => {
    const sql = await db.sql()
    expect(await fitWeights(sql, { ...bound })).toEqual(await fitWeights(sql, { ...bound }))
    expect(await fitWeights(sql, { ...bound, account: 'other' })).toEqual([])
    expect(
      await fitWeights(sql, { from: new Date('2020-01-01'), to: new Date('2020-02-01') }),
    ).toEqual([])
    expect(formatFit([], { days: 7 })).toContain('no window movement')
  })
})
