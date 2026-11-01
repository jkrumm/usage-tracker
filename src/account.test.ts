import type { SQL } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionAccount,
  parseAccount,
  resetSessionBaseUrlsCacheForTest,
  resolveAccount,
} from './models.ts'
import { migratedDb } from './pg/fixture.ts'
import { upsertSessionEnv } from './pg/session-env.ts'
import { describePg } from './pg/testing.ts'
import { upsertRecords } from './pg/writer.ts'
import { formatBillingAudit, sessionBillingAudit, stats } from './report.ts'
import type { UsageRecord } from './types.ts'

// The account dimension: Max rows take the session_env line's account (absent = "iu"), every non-Max row is NULL.

function rec(sessionId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sourceId: crypto.randomUUID(),
    grain: 'message',
    ts: new Date().toISOString(),
    model: 'claude-sonnet-5',
    project: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    raw: { sessionId },
    ...overrides,
  }
}

describePg('records.account (Postgres)', () => {
  const pg = migratedDb()
  let sql: SQL

  const accountOf = async (sourceId: string) => {
    const [row] =
      await sql`SELECT account, billing FROM usage.records WHERE source_id = ${sourceId}`
    return row
  }

  beforeEach(async () => {
    sql = await pg.reset()
  })

  test('a line with account me -> me; a line without account -> iu; a base_url (IU-paid) -> NULL', async () => {
    await upsertSessionEnv(sql, [
      { session: 's-b', base_url: '', lane: null, account: 'me' },
      { session: 's-old', base_url: '', lane: null },
      { session: 's-iu', base_url: 'https://iu.example', lane: null, account: 'me' },
    ])
    const b = rec('s-b')
    const old = rec('s-old')
    const iu = rec('s-iu')
    await upsertRecords(sql, 'claude-code', [b, old, iu])

    expect(await accountOf(b.sourceId)).toEqual({ account: 'me', billing: 'max' })
    expect(await accountOf(old.sourceId)).toEqual({ account: 'iu', billing: 'max' })
    expect(await accountOf(iu.sourceId)).toEqual({ account: null, billing: 'api_key' })
  })

  test('no session line: max defaults to iu, a source-carried account is accepted, non-claude-code sources stay NULL', async () => {
    const noLine = rec('ghost')
    const carried = rec('ghost2', { raw: { sessionId: 'ghost2', account: 'me' } })
    const legacy = rec('ghost3', { raw: { sessionId: 'ghost3', account: 'b' } })
    const hermes = rec('x')
    await upsertRecords(sql, 'claude-code', [noLine, carried, legacy])
    await upsertRecords(sql, 'hermes', [hermes])

    expect((await accountOf(noLine.sourceId)).account).toBe('iu')
    expect((await accountOf(carried.sourceId)).account).toBe('me')
    expect((await accountOf(legacy.sourceId)).account).toBe('me')
    expect(await accountOf(hermes.sourceId)).toEqual({ account: null, billing: 'api_key' })
  })

  test('an invalid account value falls back to iu; a new registry account (me2) stays its own id', async () => {
    await upsertSessionEnv(sql, [
      { session: 's-x', base_url: '', lane: null, account: 'ME2!' },
      { session: 's-me2', base_url: '', lane: null, account: 'me2' },
    ])
    const bad = rec('s-x')
    const me2 = rec('s-me2')
    await upsertRecords(sql, 'claude-code', [bad, me2])
    expect((await accountOf(bad.sourceId)).account).toBe('iu')
    expect(await accountOf(me2.sourceId)).toEqual({ account: 'me2', billing: 'max' })
  })

  test('a later line without account keeps the stored account', async () => {
    await upsertSessionEnv(sql, [{ session: 's-b', base_url: '', lane: null, account: 'me' }])
    await upsertSessionEnv(sql, [{ session: 's-b', base_url: '', lane: 'wave' }])
    const later = rec('s-b')
    await upsertRecords(sql, 'claude-code', [later])
    expect((await accountOf(later.sourceId)).account).toBe('me')
  })

  test('stats --by account and billing-audit show the split', async () => {
    await upsertSessionEnv(sql, [
      { session: 's-b', base_url: '', lane: null, account: 'me' },
      { session: 's-a', base_url: '', lane: null },
    ])
    await upsertRecords(sql, 'claude-code', [rec('s-b'), rec('s-b'), rec('s-a')])

    const byAccount = Object.fromEntries(
      (await stats(sql, { by: 'account' })).map((r) => [r.key, r.records]),
    )
    expect(byAccount).toEqual({ iu: 1, me: 2 })

    const audit = await sessionBillingAudit(sql)
    expect(audit.find((r) => r.sessionId === 's-b')?.accounts).toBe('me')
    expect(formatBillingAudit(audit)).toContain('acct')
  })
})

describePg('billing-audit (Postgres)', () => {
  const pg = migratedDb()
  let sql: SQL
  let dir: string

  beforeEach(async () => {
    sql = await pg.reset()
    dir = mkdtempSync(join(tmpdir(), 'usage-tracker-audit-'))
    process.env.USAGE_CLAUDE_LOGS_DIR = dir
    process.env.USAGE_REMOTE_DIR = join(dir, 'no-mirror')
    resetSessionBaseUrlsCacheForTest()
  })

  afterEach(() => {
    delete process.env.USAGE_CLAUDE_LOGS_DIR
    delete process.env.USAGE_REMOTE_DIR
    resetSessionBaseUrlsCacheForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  const writeEnv = (lines: Array<Record<string, unknown>>) =>
    writeFileSync(
      join(dir, '2026-10-30.jsonl'),
      lines.map((data) => JSON.stringify({ event: 'session_env', data })).join('\n') + '\n',
    )

  test('compares the stored billing with the live hook log and flags what differs', async () => {
    await upsertSessionEnv(sql, [
      { session: 's-max', base_url: '', lane: null },
      { session: 's-ca', base_url: 'https://iu.example', lane: null },
    ])
    await upsertRecords(sql, 'claude-code', [rec('s-max'), rec('s-ca'), rec('s-pruned')])
    // the live log disagrees with what was stored for s-max (a resume moved it to the IU endpoint)
    writeEnv([
      { session: 's-max', base_url: 'https://iu.example', lane: null },
      { session: 's-ca', base_url: 'https://iu.example', lane: null },
    ])

    const audit = Object.fromEntries((await sessionBillingAudit(sql)).map((r) => [r.sessionId, r]))
    expect(audit['s-max']).toMatchObject({
      billings: 'max',
      liveLabel: 'iu (ca)',
      mismatch: true,
      multiBilling: false,
    })
    expect(audit['s-ca']).toMatchObject({
      billings: 'api_key',
      liveLabel: 'iu (ca)',
      mismatch: false,
    })
    expect(audit['s-pruned']).toMatchObject({ liveLabel: 'expired/missing', mismatch: false })
    expect((await sessionBillingAudit(sql, { sessionId: 's-ca' })).map((r) => r.sessionId)).toEqual(
      ['s-ca'],
    )
    expect(formatBillingAudit(Object.values(audit))).toContain('MISMATCH')
  })
})

describe('account parsing (no database)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-tracker-account-logs-'))
    process.env.USAGE_CLAUDE_LOGS_DIR = dir
    process.env.USAGE_REMOTE_DIR = join(dir, 'no-mirror')
    resetSessionBaseUrlsCacheForTest()
  })
  afterEach(() => {
    delete process.env.USAGE_CLAUDE_LOGS_DIR
    delete process.env.USAGE_REMOTE_DIR
    resetSessionBaseUrlsCacheForTest()
    rmSync(dir, { recursive: true, force: true })
  })
  const writeEnv = (lines: Array<Record<string, unknown>>) =>
    writeFileSync(
      join(dir, '2026-10-24.jsonl'),
      lines.map((data) => JSON.stringify({ event: 'session_env', data })).join('\n') + '\n',
    )

  test('within the logs, a later line omitting account keeps the earlier one', () => {
    writeEnv([
      { session: 's-b', base_url: '', lane: null, account: 'me' },
      { session: 's-b', base_url: '', lane: 'wave' },
    ])
    expect(getSessionAccount('s-b')).toBe('me')
  })

  test('legacy a/b ids map to iu/me for log lines', () => {
    writeEnv([
      { session: 's-la', base_url: '', lane: null, account: 'a' },
      { session: 's-lb', base_url: '', lane: null, account: 'b' },
    ])
    expect(getSessionAccount('s-la')).toBe('iu')
    expect(getSessionAccount('s-lb')).toBe('me')
  })

  test('parseAccount: new registry ids pass through, legacy a/b map, invalid values are null', () => {
    expect(parseAccount('iu')).toBe('iu')
    expect(parseAccount('me')).toBe('me')
    expect(parseAccount('me2')).toBe('me2')
    expect(parseAccount('a')).toBe('iu')
    expect(parseAccount('b')).toBe('me')
    expect(parseAccount('ME2!')).toBeNull()
    expect(parseAccount('')).toBeNull()
    expect(parseAccount(42)).toBeNull()
    expect(parseAccount(null)).toBeNull()
    expect(parseAccount(undefined)).toBeNull()
  })

  test('resolveAccount: line account wins (legacy ids mapped, new ids pass through); invalid/empty/non-string falls through', () => {
    const lookup = (id: string) => (id === 's' ? 'me' : undefined)
    const resolve = (account: unknown) =>
      resolveAccount({ billing: 'max', raw: { sessionId: 's', account } }, lookup)

    expect(resolve('iu')).toBe('iu')
    expect(resolve('a')).toBe('iu')
    expect(resolve('b')).toBe('me')
    expect(resolve('me2')).toBe('me2')
    for (const bad of ['ME2!', '', 5, null, {}]) expect(resolve(bad)).toBe('me')
    expect(
      resolveAccount({ billing: 'max', raw: { sessionId: 'other', account: 'ME2!' } }, lookup),
    ).toBe('iu')
    expect(resolveAccount({ billing: 'iu', raw: { account: 'me' } }, lookup)).toBeNull()
  })
})
