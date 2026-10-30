import type { SQL } from 'bun'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { collectPicks, parsePick } from './account-picks.ts'

process.env.USAGE_MACHINE = 'Test Machine (Override)'

let dir: string
const pg = migratedDb()
let db: SQL
let savedPicks: string | undefined
let file: string

const line = (ts: string, picked = 'me') =>
  `${JSON.stringify({ ts, lane: 'wave', picked, reason: 'home', stale: false, iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } })}\n`

const state = async (): Promise<string | null> =>
  (await db`SELECT cursor FROM usage.collector_state WHERE source = 'account-picks'`)[0]?.cursor ??
  null

beforeEach(async () => {
  savedPicks = process.env.USAGE_ACCOUNT_PICKS
  dir = mkdtempSync(join(tmpdir(), 'usage-tracker-picks-'))
  file = join(dir, 'picks.jsonl')
  process.env.USAGE_ACCOUNT_PICKS = file
  db = await pg.reset()
})

afterEach(() => {
  if (savedPicks === undefined) delete process.env.USAGE_ACCOUNT_PICKS
  else process.env.USAGE_ACCOUNT_PICKS = savedPicks
  rmSync(dir, { recursive: true, force: true })
})

describePg('collectPicks (Postgres)', () => {
  test('incremental by offset, skips malformed lines and a half-written tail', async () => {
    writeFileSync(file, `${line('2026-10-24T16:00:00.000Z')}not json\n{"ts":"x"}\n`)
    expect(await collectPicks(db)).toBe(1)
    appendFileSync(
      file,
      `${line('2026-10-24T16:01:00.000Z', 'spill')}${line('2026-10-24T16:02:00.000Z').slice(0, 20)}`,
    )
    expect(await collectPicks(db)).toBe(1)
    expect(await collectPicks(db)).toBe(0)
    const rows =
      await db`SELECT picked, snapshot, stale, machine FROM usage.account_picks ORDER BY ts`
    expect(rows.map((r: { picked: string }) => r.picked)).toEqual(['me', 'spill'])
    expect(rows[0].snapshot).toEqual({ iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } })
    expect(rows[0].stale).toBe(false)
    expect(rows[0].machine).toBe('Test Machine (Override)')
    expect(await state()).toBe(
      String(
        Buffer.byteLength(
          `${line('2026-10-24T16:00:00.000Z')}not json\n{"ts":"x"}\n${line('2026-10-24T16:01:00.000Z', 'spill')}`,
        ),
      ),
    )
  })

  test('a truncated file resets the offset', async () => {
    writeFileSync(file, line('2026-10-24T16:00:00.000Z') + line('2026-10-24T16:01:00.000Z'))
    expect(await collectPicks(db)).toBe(2)
    writeFileSync(file, line('2026-10-24T17:00:00.000Z'))
    expect(await collectPicks(db)).toBe(1)
    expect((await db`SELECT count(*)::int AS n FROM usage.account_picks`)[0].n).toBe(3)
  })

  test('maps legacy ids a/b to iu/me in picked and snapshot keys; spill stays', async () => {
    const legacy = (ts: string, picked: string) =>
      `${JSON.stringify({ ts, lane: 'fan', picked, reason: 'spill', stale: false, a: { s: 1, w: 2 }, b: { s: 3, w: 4 } })}\n`
    writeFileSync(
      file,
      legacy('2026-10-24T10:00:00.000Z', 'a') +
        legacy('2026-10-24T10:01:00.000Z', 'b') +
        legacy('2026-10-24T10:02:00.000Z', 'spill'),
    )
    expect(await collectPicks(db)).toBe(3)
    const rows = await db`SELECT picked, snapshot FROM usage.account_picks ORDER BY ts`
    expect(rows.map((r: { picked: string }) => r.picked)).toEqual(['iu', 'me', 'spill'])
    expect(rows[0].snapshot).toEqual({ iu: { s: 1, w: 2 }, me: { s: 3, w: 4 } })
  })

  test('--full re-reads from the start and dedupes on (ts, lane, machine)', async () => {
    writeFileSync(file, line('2026-10-24T16:00:00.000Z') + line('2026-10-24T16:01:00.000Z'))
    expect(await collectPicks(db)).toBe(2)
    expect(await collectPicks(db, { full: true })).toBe(0)
    expect((await db`SELECT count(*)::int AS n FROM usage.account_picks`)[0].n).toBe(2)
  })

  test('a missing picks file is a no-op', async () => {
    expect(await collectPicks(db)).toBe(0)
    expect(await state()).toBeNull()
  })
})

test('parsePick keeps a malformed line out and maps the legacy ids', () => {
  expect(parsePick('nope')).toBeNull()
  expect(parsePick('{"ts":"2026-10-24T10:00:00Z","lane":"x"}')).toBeNull()
  expect(
    parsePick(
      '{"ts":"2026-10-24T10:00:00Z","lane":"x","picked":"a","reason":"r","stale":true,"b":{"s":1}}',
    ),
  ).toEqual({
    ts: Date.parse('2026-10-24T10:00:00Z'),
    lane: 'x',
    picked: 'iu',
    reason: 'r',
    stale: true,
    snapshot: { me: { s: 1 } },
  })
})
