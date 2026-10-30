import type { SQL } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { collectQuota, formatQuotaReport, parseAccountUsage } from './claude-quota.ts'

process.env.USAGE_MACHINE = 'Test Machine (Override)'

const acct = (over: Record<string, unknown>) => ({
  id: 'iu',
  plan: 'max20x',
  enabled: true,
  five_hour: 10,
  seven_day: 88,
  five_hour_resets_at: 1792867800,
  seven_day_resets_at: 1793203200,
  age_s: 79,
  five_hour_age_s: 79,
  seven_day_age_s: 90,
  source: 'statusline',
  auth_ok: true,
  exhausted_until: null,
  ...over,
})

let dir: string
const pg = migratedDb()
let db: SQL
let savedBin: string | undefined

/** Fake claude-account: prints `body` and exits with `code`. */
function fakeCli(body: unknown, code = 0): void {
  const bin = join(dir, 'claude-account')
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${text}\nJSON\nexit ${code}\n`)
  chmodSync(bin, 0o755)
  process.env.USAGE_CLAUDE_ACCOUNT_BIN = bin
}

beforeEach(async () => {
  savedBin = process.env.USAGE_CLAUDE_ACCOUNT_BIN
  dir = mkdtempSync(join(tmpdir(), 'usage-tracker-quota-'))
  db = await pg.reset()
})

afterEach(() => {
  if (savedBin === undefined) delete process.env.USAGE_CLAUDE_ACCOUNT_BIN
  else process.env.USAGE_CLAUDE_ACCOUNT_BIN = savedBin
  rmSync(dir, { recursive: true, force: true })
})

describePg('collectQuota (Postgres)', () => {
  test('dedupes an unchanged cached sample; sampled_at = now - min age', async () => {
    fakeCli({ accounts: [acct({})] })
    expect(await collectQuota(db, 1_000_000)).toBe(1)
    // same cache, ages grown by the elapsed 60 s -> same observation time
    fakeCli({ accounts: [acct({ five_hour_age_s: 139, seven_day_age_s: 150 })] })
    expect(await collectQuota(db, 1_060_000)).toBe(0)
    const [row] =
      await db`SELECT (extract(epoch FROM sampled_at) * 1000)::float8 AS sampled_at, count(*) OVER ()::int AS n FROM usage.quota_samples`
    expect(row).toEqual({ sampled_at: 1_000_000 - 79_000, n: 1 })
  })

  test('skips disabled accounts and accounts with both windows null', async () => {
    fakeCli({
      accounts: [
        acct({ id: 'a1', enabled: false }),
        acct({ id: 'a2', five_hour: null, seven_day: null }),
        acct({ id: 'me', seven_day: null }),
      ],
    })
    expect(await collectQuota(db, 5_000_000)).toBe(1)
    expect([...(await db`SELECT account FROM usage.quota_samples`)]).toEqual([{ account: 'me' }])
  })

  test('stores the windows, resets, auth and source; out-of-range values are clamped, bad epochs NULL', async () => {
    fakeCli({
      accounts: [
        acct({
          id: 'me',
          five_hour: 104,
          seven_day: 0,
          exhausted_until: 1792867900,
          auth_ok: false,
          seven_day_resets_at: 1e18,
        }),
      ],
    })
    expect(await collectQuota(db, 1_000_000)).toBe(1)
    const [row] = await db`
      SELECT five_hour_pct, seven_day_pct, extract(epoch FROM five_hour_resets_at)::int AS five_reset, seven_day_resets_at,
             auth_ok, extract(epoch FROM exhausted_until)::int AS exhausted, source, machine
      FROM usage.quota_samples`
    expect(row).toEqual({
      five_hour_pct: 100,
      seven_day_pct: 0,
      five_reset: 1792867800,
      seven_day_resets_at: null,
      auth_ok: false,
      exhausted: 1792867900,
      source: 'statusline',
      machine: 'Test Machine (Override)',
    })
  })

  test('a missing CLI is a silent skip', async () => {
    process.env.USAGE_CLAUDE_ACCOUNT_BIN = join(dir, 'nope')
    expect(await collectQuota(db)).toBe(0)
  })

  test('a non-zero exit stores nothing', async () => {
    fakeCli({ accounts: [acct({})] }, 3)
    expect(await collectQuota(db)).toBe(0)
  })

  test('a malformed entry is skipped, the others are kept', async () => {
    fakeCli({
      accounts: [
        acct({ id: 'iu', five_hour: 'lots' }),
        null,
        acct({ id: 'me' }),
        acct({ id: 'x', five_hour_age_s: -5 }),
      ],
    })
    expect(await collectQuota(db, 5_000_000)).toBe(1)
    expect([...(await db`SELECT account FROM usage.quota_samples`)]).toEqual([{ account: 'me' }])
  })

  test('non-JSON output stores nothing', async () => {
    fakeCli('oops')
    expect(await collectQuota(db)).toBe(0)
  })
})

describe('parseAccountUsage', () => {
  test('accepts nulls, rejects wrong types', () => {
    expect(parseAccountUsage(acct({ five_hour: null, auth_ok: null }))).not.toBeNull()
    expect(parseAccountUsage(acct({ id: '' }))).toBeNull()
    expect(parseAccountUsage(acct({ auth_ok: 'yes' }))).toBeNull()
    expect(parseAccountUsage(acct({ seven_day_resets_at: Number.NaN }))).toBeNull()
    expect(parseAccountUsage('nope')).toBeNull()
  })
})

describePg('formatQuotaReport (Postgres)', () => {
  test('summarises series and picks', async () => {
    fakeCli({ accounts: [acct({})] })
    await collectQuota(db)
    await db`INSERT INTO usage.account_picks (ts, lane, picked, reason, stale, snapshot, machine)
             VALUES (now(), 'wave', 'me', 'home', false, '{}', 'm')`
    const out = await formatQuotaReport(db)
    expect(out).toContain('5h min/max/last=10/10/10%')
    expect(out).toMatch(/wave\s+me\s+home\s+1/)
  })
})
