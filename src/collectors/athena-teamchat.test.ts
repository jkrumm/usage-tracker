import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { upsertRecords } from '../pg/writer.ts'
import type { Logger } from '../types.ts'
import { athenaTeamchatCollector, toRecord, type AthenaRow } from './athena-teamchat.ts'

process.env.USAGE_MACHINE = 'Test Machine (Override)'
// Never read the real archive from a test; the archive tests point it at a scratch file.
process.env.ATHENA_ARCHIVE_DB = join(tmpdir(), 'usage-tracker-no-such-archive.sqlite')
const log: Logger = { info() {}, warn() {}, error() {} }

const row = (over: Partial<AthenaRow> = {}): AthenaRow => ({
  kind: 'turn',
  id: 1,
  ts: '2026-10-27T10:00:00+00:00',
  touched: '2026-10-27T10:00:00+00:00',
  tool: 'chat-turn:chat',
  ok: true,
  tokens_in: 100,
  tokens_out: 20,
  cache_read: 5000,
  cache_write: 0,
  cost: 0.0123,
  ms: 4200,
  ...over,
})

describe('athena-teamchat collector', () => {
  test("maps a turn: tokens as-is, OpenCode's cost authoritative, no model", () => {
    expect(toRecord(row())).toMatchObject({
      sourceId: 'turn:1',
      ts: '2026-10-27T10:00:00.000Z',
      model: null,
      subTool: 'chat-turn:chat',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5000,
      durationMs: 4200,
      outcome: 'ok',
      authoritativeCostUsd: 0.0123,
    })
  })

  test('a failed call is an error row; source ids never collide across the three tables', () => {
    expect(toRecord(row({ kind: 'llm', id: 1, ok: false })).outcome).toBe('error')
    const ids = [row(), row({ kind: 'llm' }), row({ kind: 'title' })].map(
      (r) => toRecord(r).sourceId,
    )
    expect(new Set(ids).size).toBe(3)
  })

  test('first run reads everything, later runs overlap three days behind the newest row', async () => {
    const seen: string[] = []
    const c = athenaTeamchatCollector(async (since) => {
      seen.push(since)
      return [
        row({ ts: '2026-10-27T10:00:00Z', touched: '2026-10-27T10:00:00Z' }),
        row({ id: 2, ts: '2026-10-28T08:00:00Z', touched: '2026-10-28T09:00:00Z' }),
      ]
    })
    const first = await c.collect({ cursor: null, full: false, log })
    expect(seen[0]).toBe('1970-01-01T00:00:00Z')
    expect(JSON.parse(first.cursor!)).toMatchObject({ newest: '2026-10-28T09:00:00.000Z' })
    await c.collect({ cursor: first.cursor, full: false, log })
    expect(seen[1]).toBe('2026-10-25T09:00:00.000Z')
    await c.collect({ cursor: first.cursor, full: true, log })
    expect(seen[2]).toBe('1970-01-01T00:00:00Z')
  })

  test('the cursor follows when a row last changed, so a turn that ends late is re-read', async () => {
    const c = athenaTeamchatCollector(async () => [
      row({ ts: '2026-10-20T10:00:00Z', touched: '2026-10-28T09:00:00Z' }),
    ])
    const out = await c.collect({ cursor: null, full: false, log })
    expect(JSON.parse(out.cursor!)).toMatchObject({ newest: '2026-10-28T09:00:00.000Z' })
  })

  test('a row with an unparseable timestamp is skipped and logged, the rest still lands', async () => {
    const warned: string[] = []
    const c = athenaTeamchatCollector(async () => [row({ ts: 'garbage' }), row({ id: 2 })])
    const out = await c.collect({
      cursor: null,
      full: false,
      log: { ...log, warn: (m) => warned.push(m) },
    })
    expect(out.records.map((r) => r.sourceId)).toEqual(['turn:2'])
    expect(warned[0]).toContain('turn:1')
  })

  test('the SQLite archive of the build phase is read once, as its own source ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-tracker-athena-archive-'))
    const path = join(dir, 'chat.sqlite')
    const sqlite = new Database(path, { create: true })
    sqlite.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY, started_at TEXT, ended_at TEXT, outcome TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, ms INTEGER);
      CREATE TABLE title_calls (id INTEGER PRIMARY KEY, created_at TEXT, ok INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost REAL, ms INTEGER);
      INSERT INTO turns VALUES (1,'2026-10-23T10:00:00+00:00','2026-10-23T10:01:00+00:00','succeeded',100,10,5000,0,0.5,60000),
                               (2,'2026-10-23T11:00:00+00:00',NULL,'error:model_down',1,0,0,0,0.01,5);
      INSERT INTO title_calls VALUES (1,'2026-10-24T14:36:09+00:00',1,50,5,0.001,900);`)
    sqlite.close()
    process.env.ATHENA_ARCHIVE_DB = path
    try {
      const c = athenaTeamchatCollector(async () => [row({ id: 9 })])
      const first = await c.collect({ cursor: null, full: false, log })
      expect(first.records.map((r) => r.sourceId).sort()).toEqual([
        'sqlite-title:1',
        'sqlite-turn:1',
        'sqlite-turn:2',
        'turn:9',
      ])
      expect(first.records.find((r) => r.sourceId === 'sqlite-turn:2')!.outcome).toBe('error')
      expect(first.records.find((r) => r.sourceId === 'sqlite-turn:1')).toMatchObject({
        authoritativeCostUsd: 0.5,
        cacheReadTokens: 5000,
      })
      const again = await c.collect({ cursor: first.cursor, full: false, log })
      expect(again.records.map((r) => r.sourceId)).toEqual(['turn:9'])
      const full = await c.collect({ cursor: first.cursor, full: true, log })
      expect(full.records).toHaveLength(4)
    } finally {
      process.env.ATHENA_ARCHIVE_DB = join(tmpdir(), 'usage-tracker-no-such-archive.sqlite')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describePg('into the table (Postgres)', () => {
    const pg = migratedDb()

    test('rows are billing=api_key on the team key with their own cost, and a re-read changes nothing', async () => {
      const db = await pg.reset()
      const records = [
        row(),
        row({ kind: 'llm', id: 7, tool: 'llm:readiness', cache_read: 0, cost: 0.0004 }),
      ].map(toRecord)
      expect(
        (await upsertRecords(db, 'athena-teamchat', records, { defaultWorkspace: 'work' })).newRows,
      ).toBe(2)
      expect(
        (await upsertRecords(db, 'athena-teamchat', records, { defaultWorkspace: 'work' })).newRows,
      ).toBe(0)
      expect([
        ...(await db`SELECT billing, api_key, cost_source, round(cost_usd, 4)::float8 AS cost FROM usage.records ORDER BY source_id`),
      ]).toEqual([
        { billing: 'api_key', api_key: 'athena-team', cost_source: 'reported', cost: 0.0004 },
        { billing: 'api_key', api_key: 'athena-team', cost_source: 'reported', cost: 0.0123 },
      ])
    })
  })
})
