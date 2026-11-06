import type { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { collectors } from './collectors/index.ts'
import { migratedDb } from './pg/fixture.ts'
import { describePg } from './pg/testing.ts'
import {
  attributionHealth,
  formatAttributionHealth,
  REPO_NULL_SHARE_LIMIT,
  staleSources,
} from './report.ts'

const pg = migratedDb()
let sql: SQL

beforeEach(async () => {
  sql = await pg.reset()
})

/** Records of a source at the given timestamps; only `source` and `ts` matter to the freshness judgement. */
async function seed(rows: Array<[string, string]>): Promise<void> {
  for (const [source, ts] of rows) {
    await sql`
      INSERT INTO usage.records (source, source_id, grain, ts, billing, lane)
      VALUES (${source}, ${`${source}-${ts}`}, 'message', ${ts}::timestamptz, 'unknown', 'other')`
  }
}

const NOW = new Date('2026-10-22T12:00:00Z')
const present = (source: string, staleAfterHours: number | null) => ({
  source,
  staleAfterHours,
  available: () => true,
})

describePg('staleSources (Postgres)', () => {
  test('flags a source whose newest row is older than its cadence', async () => {
    await seed([
      ['a', '2026-10-13T12:34:00Z'],
      ['b', '2026-10-22T11:00:00Z'],
    ])
    const stale = await staleSources(sql, [present('a', 48), present('b', 48)], NOW)
    expect(stale.map((s) => s.source)).toEqual(['a'])
    expect(stale[0]).toMatchObject({ newestTs: '2026-10-13T12:34:00.000Z', limitHours: 48 })
  })

  test("the newest of a source's rows counts, not the first", async () => {
    await seed([
      ['a', '2026-10-01T00:00:00Z'],
      ['a', '2026-10-22T10:00:00Z'],
    ])
    expect(await staleSources(sql, [present('a', 48)], NOW)).toEqual([])
  })

  test('a present source with no rows is stale; null cadence and absent sources are ignored', async () => {
    const absent = { source: 'gone', staleAfterHours: 24, available: () => false }
    const stale = await staleSources(
      sql,
      [present('empty', 24), present('legacy', null), absent],
      NOW,
    )
    expect(stale.map((s) => s.source)).toEqual(['empty'])
  })

  test('a vanished store that once produced rows is stale; a future-dated newest row is not fresh', async () => {
    await seed([
      ['moved', '2026-10-13T12:00:00Z'],
      ['future', '2030-01-01T00:00:00Z'],
    ])
    const moved = { source: 'moved', staleAfterHours: 48, available: () => false }
    const stale = await staleSources(sql, [moved, present('future', 48)], NOW)
    expect(stale.map((s) => s.source)).toEqual(['moved', 'future'])
  })

  test('age exactly at the limit is fresh', async () => {
    await seed([['a', '2026-10-20T12:00:00Z']])
    expect(await staleSources(sql, [present('a', 48)], NOW)).toEqual([])
  })

  test('a source with its own freshness probe (no records) is judged on that', async () => {
    const probe = (newest: string | null) => ({
      ...present('portal', 48),
      newest: async () => newest,
    })
    expect((await staleSources(sql, [probe('2026-10-22T00:00:00.000Z')], NOW)).length).toBe(0)
    expect(
      (await staleSources(sql, [probe('2026-10-10T00:00:00.000Z')], NOW)).map((s) => s.source),
    ).toEqual(['portal'])
  })
})

/** One record with a repo (or none) and a token count; `project` is the project_raw the NULL-repo shapes are read from. */
async function put(o: {
  id: string
  repo: string | null
  tokens: number
  ts?: string
  project?: string
  source?: string
}): Promise<void> {
  await sql`
    INSERT INTO usage.records (source, source_id, grain, ts, billing, lane, repo, project_raw, input_tokens)
    VALUES (${o.source ?? 'claude-code'}, ${o.id}, 'message', ${o.ts ?? '2026-10-21T12:00:00Z'}::timestamptz, 'unknown', 'other',
            ${o.repo}, ${o.project ?? null}, ${o.tokens})`
}

describePg('attributionHealth (Postgres)', () => {
  const known = new Set(['argo', 'iu/epos-tool-athena'])

  test('passes when every repo is known and few tokens are unattributed', async () => {
    await put({ id: 'a', repo: 'argo', tokens: 950 })
    await put({ id: 'b', repo: null, tokens: 50 })
    const h = await attributionHealth(sql, { known, now: NOW })
    expect(h).toMatchObject({ unknownRepos: [], ok: true })
    expect(h.nullShare).toBeCloseTo(0.05)
    expect(formatAttributionHealth(h)).toBe('')
  })

  test('an unknown repo fails and is listed with its rows', async () => {
    await put({ id: 'a', repo: 'argo', tokens: 1000 })
    await put({ id: 'b', repo: 'worktrees', tokens: 1 })
    await put({ id: 'c', repo: 'worktrees', tokens: 1 })
    const h = await attributionHealth(sql, { known, now: NOW })
    expect(h.ok).toBe(false)
    expect(h.unknownRepos).toEqual([{ repo: 'worktrees', rows: 2 }])
    expect(formatAttributionHealth(h)).toContain('worktrees (2 rows)')
  })

  test('a NULL share over the limit fails and names the heaviest project_raw shapes, uuids folded', async () => {
    await put({ id: 'a', repo: 'argo', tokens: 500 })
    await put({
      id: 'b',
      repo: null,
      tokens: 300,
      project: '/h/.local/state/sideclaw/worktrees/d1cef3da-967c-4752-9154-e638f682efbe',
    })
    await put({
      id: 'c',
      repo: null,
      tokens: 200,
      project: '/h/.local/state/sideclaw/worktrees/67aa96ae-1d0e-4466-a8f1-cd3a42eae43f',
    })
    const h = await attributionHealth(sql, { known, now: NOW })
    expect(h.ok).toBe(false)
    expect(h.nullShare).toBeCloseTo(0.5)
    expect(h.shapes).toEqual([
      { shape: 'claude-code | /h/.local/state/sideclaw/worktrees/<uuid>', tokens: 500 },
    ])
    expect(formatAttributionHealth(h)).toContain('50.0%')
  })

  test('the limit is injectable and the default is 10%', async () => {
    expect(REPO_NULL_SHARE_LIMIT).toBe(0.1)
    await put({ id: 'a', repo: 'argo', tokens: 800 })
    await put({ id: 'b', repo: null, tokens: 200 })
    expect((await attributionHealth(sql, { known, now: NOW })).ok).toBe(false)
    expect((await attributionHealth(sql, { known, now: NOW, limit: 0.3 })).ok).toBe(true)
  })

  test('only the last 7 days of records_unique count: old rows and marked duplicates are ignored', async () => {
    await put({ id: 'old', repo: 'gone', tokens: 1000, ts: '2026-10-01T00:00:00Z' })
    await put({ id: 'a', repo: 'argo', tokens: 100 })
    await put({ id: 'dup', repo: 'dup-repo', tokens: 100 })
    await sql`INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
              SELECT d.id, a.id, 'test' FROM usage.records d, usage.records a WHERE d.source_id = 'dup' AND a.source_id = 'a'`
    const got = await attributionHealth(sql, { known, now: NOW })
    expect(got).toMatchObject({ unknownRepos: [], ok: true, nullShare: 0 })
  })

  test('no tokens at all is healthy', async () => {
    expect(await attributionHealth(sql, { known, now: NOW })).toMatchObject({
      nullShare: null,
      ok: true,
    })
  })
})

test('every registered collector declares its cadence (a number, or null for legacy/dormant)', () => {
  for (const c of collectors)
    expect(c.staleAfterHours === null || typeof c.staleAfterHours === 'number').toBe(true)
})
