import type { SQL } from 'bun'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { iuKeyDef } from '../iu-keys.ts'
import { runIngest } from '../ingest.ts'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { upsertRecords } from '../pg/writer.ts'
import { staleSources } from '../report.ts'
import {
  collectPortal,
  iuPortalFreshness,
  iuPortalFreshnessAll,
  readPortalState,
  type PortalFetch,
} from './iu-portal.ts'

const NOW = Date.parse('2026-10-26T08:00:00Z')
const H = 3_600_000
const PERSONAL = [iuKeyDef('personal')!]

const daily = {
  fetched_at: '2026-10-26T08:00:00Z',
  cost_center: 'CC00000',
  total_usd: 7,
  granularity: 'daily',
  periods: ['2026-10-25', '2026-10-26'],
  rows: [
    { label: 'Claude Haiku 5 5 Eu', row: 1, cells: { '2026-10-25': 3, '2026-10-26': 2 } },
    { label: 'Mystery Model', row: 2, cells: { '2026-10-26': 2 } },
  ],
}
const monthly = {
  ...daily,
  granularity: 'monthly',
  periods: ['2026-08', '2026-09', '2026-10'],
  rows: [
    { label: 'Claude Haiku 5 5 Eu', row: 1, cells: { '2026-08': 9, '2026-09': 100, '2026-10': 5 } },
  ],
}
const ok = (...docs: object[]): PortalFetch => ({
  code: 0,
  stdout: docs.map((d) => JSON.stringify(d)).join('\n'),
  stderr: '',
})

const pg = migratedDb()
let dir: string
let db: SQL
let prevRoot: string | undefined
const latestFile = () => join(dir, 'iu-portal', 'latest.json')

beforeEach(async () => {
  db = await pg.reset()
  dir = mkdtempSync(join(tmpdir(), 'usage-tracker-portal-'))
  prevRoot = process.env.IU_PORTAL_ROOT
  process.env.IU_PORTAL_ROOT = join(dir, 'iu-portal')
  // one IU-billed record: the portal labels are matched against the models we track
  await upsertRecords(db, 'opencode', [
    {
      sourceId: '1',
      grain: 'message',
      ts: '2026-10-26T01:00:00Z',
      model: 'claude-haiku-5-5-eu',
      project: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  ])
})
afterEach(() => {
  if (prevRoot === undefined) delete process.env.IU_PORTAL_ROOT
  else process.env.IU_PORTAL_ROOT = prevRoot
  rmSync(dir, { recursive: true, force: true })
})

const cost = async () =>
  (
    await db`SELECT day::text AS day, label, "row", model, cost_usd::float8 AS cost_usd FROM usage.iu_portal_cost ORDER BY day, "row"`
  ).map((r: Record<string, unknown>) => ({ ...r }))

describePg('collectPortal (Postgres)', () => {
  test('stores non-zero cells, maps labels onto model_norm, keeps unmatched ones NULL', async () => {
    expect(
      await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily, monthly) }),
    ).toBe(3)
    expect(await cost()).toEqual([
      {
        day: '2026-10-25',
        label: 'Claude Haiku 5 5 Eu',
        row: 1,
        model: 'claude-haiku-5-5',
        cost_usd: 3,
      },
      {
        day: '2026-10-26',
        label: 'Claude Haiku 5 5 Eu',
        row: 1,
        model: 'claude-haiku-5-5',
        cost_usd: 2,
      },
      { day: '2026-10-26', label: 'Mystery Model', row: 2, model: null, cost_usd: 2 },
    ])
    // the first monthly period is a partial window and is dropped
    expect([
      ...(await db`SELECT month, total_usd::float8 AS total_usd FROM usage.iu_portal_total ORDER BY month`),
    ]).toEqual([
      { month: '2026-09', total_usd: 100 },
      { month: '2026-10', total_usd: 5 },
    ])
    expect(await readPortalState(db)).toMatchObject({
      lastOk: NOW,
      lastCode: 0,
      lastDay: '2026-10-26',
    })
  })

  test('writes the schema-1 latest.json on success (dir created) and leaves it on failure', async () => {
    expect(existsSync(latestFile())).toBe(false)
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily, monthly) })
    const written = readFileSync(latestFile(), 'utf8')
    expect(JSON.parse(written)).toMatchObject({
      schema: 1,
      fetched_at: '2026-10-26T08:00:00Z',
      limit_usd: 500,
      window_days: 30,
      rolling30_usd: 7,
      can_spend_today_usd: 497,
    })
    expect(existsSync(`${latestFile()}.tmp`)).toBe(false)

    const failures: PortalFetch[] = [
      { code: 3, stdout: '', stderr: 'session expired' },
      { code: 255, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'boom' },
      ok({ granularity: 'daily' }),
    ]
    for (const [i, f] of failures.entries()) {
      await collectPortal(db, {
        keys: PERSONAL,
        now: NOW + (5 + i * 5) * H,
        force: true,
        fetch: async () => f,
      })
      expect(readFileSync(latestFile(), 'utf8')).toBe(written)
    }
  })

  test('latest fetch wins: a grown value is updated and a vanished cell removed', async () => {
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily) })
    const next = {
      ...daily,
      rows: [{ ...daily.rows[0]!, cells: { '2026-10-25': 3, '2026-10-26': 4 } }],
    }
    await collectPortal(db, { keys: PERSONAL, now: NOW + 5 * H, fetch: async () => ok(next) })
    expect((await cost()).map((r: Record<string, unknown>) => r.cost_usd)).toEqual([3, 4])
  })

  test('throttled to one fetch per 4 h', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return ok(daily)
    }
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch })
    expect(await collectPortal(db, { keys: PERSONAL, now: NOW + 3 * H, fetch })).toBe(0)
    await collectPortal(db, { keys: PERSONAL, now: NOW + 4 * H, fetch })
    expect(calls).toBe(2)
  })

  test('an unreachable MacBook retries next run and never throws; the old data stays', async () => {
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily) })
    let calls = 0
    const down = async () => {
      calls++
      return { code: 255, stdout: '', stderr: 'ssh: connect failed' }
    }
    expect(await collectPortal(db, { keys: PERSONAL, now: NOW + 5 * H, fetch: down })).toBe(0)
    expect(
      await collectPortal(db, { keys: PERSONAL, now: NOW + 5 * H + 900_000, fetch: down }),
    ).toBe(0)
    expect(calls).toBe(2)
    expect(await cost()).toHaveLength(3)
    expect((await readPortalState(db)).lastOk).toBe(NOW)
  })

  test('an expired session backs off for 4 h instead of retrying every run', async () => {
    let calls = 0
    const expired = async () => {
      calls++
      return { code: 3, stdout: '', stderr: 'session expired' }
    }
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: expired })
    await collectPortal(db, { keys: PERSONAL, now: NOW + 900_000, fetch: expired })
    expect(calls).toBe(1)
    await collectPortal(db, { keys: PERSONAL, now: NOW + 4 * H, fetch: expired })
    expect(calls).toBe(2)
    expect(
      (
        await db`SELECT last_status, last_note FROM usage.collector_state WHERE source = 'iu-portal'`
      )[0],
    ).toEqual({
      last_status: 'error',
      last_note: 'session expired — run make iu-portal-login',
    })
  })

  test('any other failure backs off 1 h, an unreachable MacBook does not', async () => {
    let calls = 0
    const broken = async () => {
      calls++
      return { code: 1, stdout: '', stderr: 'boom' }
    }
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: broken })
    await collectPortal(db, { keys: PERSONAL, now: NOW + 900_000, fetch: broken })
    expect(calls).toBe(1)
    await collectPortal(db, { keys: PERSONAL, now: NOW + H, fetch: broken })
    expect(calls).toBe(2)
  })

  test('garbage output is a failure, not an exception, and writes nothing', async () => {
    expect(
      await collectPortal(db, {
        keys: PERSONAL,
        now: NOW,
        fetch: async () => ok({ granularity: 'daily' }),
      }),
    ).toBe(0)
    expect(await cost()).toEqual([])
  })
})

describePg('collectPortal per IU key (Postgres)', () => {
  const seenKeys: string[] = []
  const fetchBy =
    (docs: Record<string, object>, code = 0) =>
    async (def: { id: string }): Promise<PortalFetch> => {
      seenKeys.push(def.id)
      return code === 0 ? ok(docs[def.id]!) : { code, stdout: '', stderr: '' }
    }
  const teamDaily = {
    ...daily,
    rows: [{ label: 'Claude Haiku 5 5 Eu', row: 1, cells: { '2026-10-26': 40 } }],
  }
  beforeEach(() => {
    seenKeys.length = 0
  })

  test('each key is fetched with its own definition and stored apart; state is per key', async () => {
    const n = await collectPortal(db, {
      now: NOW,
      fetch: fetchBy({ personal: daily, 'athena-team': teamDaily }),
    })
    expect(n).toBe(4)
    expect(seenKeys).toEqual(['personal', 'athena-team'])
    expect([
      ...(await db`SELECT iu_key, sum(cost_usd)::float8 AS usd FROM usage.iu_portal_cost GROUP BY iu_key ORDER BY iu_key`),
    ]).toEqual([
      { iu_key: 'athena-team', usd: 40 },
      { iu_key: 'personal', usd: 7 },
    ])
    expect((await readPortalState(db, 'athena-team')).lastOk).toBe(NOW)
    expect((await readPortalState(db, 'personal')).lastOk).toBe(NOW)
  })

  test('only the personal report becomes latest.json', async () => {
    await collectPortal(db, {
      now: NOW,
      fetch: fetchBy({ personal: daily, 'athena-team': teamDaily }),
    })
    const latest = JSON.parse(
      readFileSync(join(process.env.IU_PORTAL_ROOT!, 'latest.json'), 'utf8'),
    )
    expect(latest.rolling30_usd).toBe(7)
  })

  test("a team-key refetch replaces only the team key's days", async () => {
    await collectPortal(db, {
      now: NOW,
      fetch: fetchBy({ personal: daily, 'athena-team': teamDaily }),
    })
    await collectPortal(db, {
      now: NOW + 5 * H,
      fetch: fetchBy({ personal: daily, 'athena-team': { ...teamDaily, rows: [] } }),
    })
    expect([
      ...(await db`SELECT iu_key, count(*)::int AS n FROM usage.iu_portal_cost GROUP BY iu_key`),
    ]).toEqual([{ iu_key: 'personal', n: 3 }])
  })

  test('a signed-out session ends the pass: no second browser launch for the next key', async () => {
    expect(await collectPortal(db, { now: NOW, fetch: fetchBy({}, 3) })).toBe(0)
    expect(seenKeys).toEqual(['personal'])
  })

  test('a failing team key does not touch the personal report or its state', async () => {
    const fetch = async (def: { id: string }): Promise<PortalFetch> =>
      def.id === 'personal' ? ok(daily) : { code: 1, stdout: '', stderr: 'key unresolvable' }
    expect(await collectPortal(db, { now: NOW, fetch })).toBe(3)
    expect((await readPortalState(db, 'personal')).lastCode).toBe(0)
    expect(await readPortalState(db, 'athena-team')).toMatchObject({ lastOk: null, lastCode: 1 })
  })
})

describePg('iuPortalFreshnessAll (Postgres)', () => {
  test('a secondary key that was never tried is not stale; one that keeps failing is', async () => {
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily) })
    expect(await staleSources(db, iuPortalFreshnessAll, new Date(NOW + H))).toEqual([])
    await collectPortal(db, {
      now: NOW,
      fetch: async (def) =>
        def.id === 'personal' ? ok(daily) : { code: 1, stdout: '', stderr: 'x' },
    })
    expect(
      (await staleSources(db, iuPortalFreshnessAll, new Date(NOW + H))).map((s) => s.source),
    ).toEqual(['iu-portal:athena-team'])
  })
})

describePg('iuPortalFreshness (Postgres)', () => {
  test('health flags a portal that has not succeeded for 48 h, and one that never did', async () => {
    const at = new Date(NOW + 60 * H)
    expect((await staleSources(db, [iuPortalFreshness], at)).map((s) => s.source)).toEqual([
      'iu-portal',
    ])
    await collectPortal(db, { keys: PERSONAL, now: NOW, fetch: async () => ok(daily) })
    expect(await staleSources(db, [iuPortalFreshness], new Date(NOW + 47 * H))).toEqual([])
    expect((await staleSources(db, [iuPortalFreshness], at)).map((s) => s.source)).toEqual([
      'iu-portal',
    ])
  })
})

describePg('ingest (Postgres)', () => {
  test('a failing portal fetch never fails the ingest run', async () => {
    const down = async () => ({ code: 255, stdout: '', stderr: '' })
    const summary = await runIngest(db, {
      collectors: [],
      accounts: false,
      portal: true,
      portalFetch: down,
    })
    expect(summary.portal).toBe(0)
    const live = await runIngest(db, {
      collectors: [],
      accounts: false,
      portal: true,
      portalFetch: async () => ok(daily),
    })
    expect(live.portal).toBe(6) // 3 cells for each of the two IU keys
  })
})
