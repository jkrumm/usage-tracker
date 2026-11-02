import type { SQL } from 'bun'
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { runIngest } from '../ingest.ts'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { AdminApiError, fetchCost } from './admin-api.ts'
import { runCreditPass, type PlatformAccount } from './index.ts'

// A fake Admin API on port 0: the tests never touch the network. Data is a flat list of daily cost rows; the server
// filters by the requested window, pages by two rows (to force paging) and answers per admin key.

interface FakeRow {
  day: string
  model: string | null
  key: string | null
  amount: string
}

const state = {
  data: {} as Record<string, FakeRow[]>,
  refreshed: '2026-11-02T08:00:00Z',
  status: {} as Record<string, number>,
  seen: [] as Array<{ key: string; url: URL; headers: Headers }>,
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    const key = req.headers.get('x-api-key') ?? ''
    state.seen.push({ key, url, headers: req.headers })
    const status = state.status[key]
    if (status) return new Response('{"error":"nope"}', { status })
    const from = url.searchParams.get('starting_at')!.slice(0, 10)
    const to = url.searchParams.get('ending_at')!.slice(0, 10)
    const rows = (state.data[key] ?? []).filter((r) => r.day >= from && r.day < to)
    const offset = Number(url.searchParams.get('page') ?? 0)
    const page = rows.slice(offset, offset + 2)
    const more = offset + 2 < rows.length
    return Response.json({
      data: page.map((r) => ({
        starting_at: `${r.day}T00:00:00Z`,
        ending_at: `${r.day}T23:59:59Z`,
        group: { model: r.model, api_key_id: r.key },
        cost: { amount: r.amount, list_amount: r.amount, currency: 'USD', requests: 1 },
      })),
      has_more: more,
      next_page: more ? String(offset + 2) : null,
      data_refreshed_at: state.refreshed,
    })
  },
})
afterAll(() => server.stop(true))
const baseUrl = `http://localhost:${server.port}`

const IU: PlatformAccount = { id: 'iu', creditUsd: 200, cycleDay: 21, adminKeyRef: 'ref-iu' }
const ME: PlatformAccount = { id: 'me', creditUsd: 100, cycleDay: 27, adminKeyRef: 'ref-me' }
const ME2: PlatformAccount = { id: 'me2', creditUsd: 100, cycleDay: null, adminKeyRef: 'ref-me2' }
const secrets: Record<string, string | null> = {
  'ref-iu': 'iu-key',
  'ref-me': 'me-key',
  'ref-me2': null, // a REPLACE… placeholder resolves to null
}
const resolveSecret = async (ref: string) => secrets[ref] ?? null
const NOW = new Date('2026-11-02T10:00:00Z')

const run = (accounts: PlatformAccount[], over: { now?: Date } = {}, sql?: SQL) =>
  runCreditPass(sql ?? db, { accounts, resolveSecret, baseUrl, now: over.now ?? NOW })

let db: SQL
const pg = migratedDb()

async function costOf(account: string) {
  return db`SELECT day::text, model, api_key_id, cost_usd::float8 AS cost_usd, refreshed_at FROM usage.platform_cost
            WHERE account = ${account} ORDER BY day, model NULLS FIRST, api_key_id NULLS FIRST`
}
async function cycles(account: string) {
  return db`SELECT cycle_start, cycle_end, grant_usd::float8 AS grant, metered_usd::float8 AS metered,
                   reconciled_usd::float8 AS reconciled, unspent_usd::float8 AS unspent, closed_at
            FROM usage.credit_cycles WHERE account = ${account} ORDER BY cycle_start`
}
const gatewayRow = (id: string, over: Record<string, unknown>) => ({
  source: 'gateway',
  billing: 'api_credit',
  account: 'iu',
  ts: '2026-10-25T10:00:00Z',
  cost_usd: null as number | null,
  lane_detail: {} as Record<string, unknown>,
  id,
  ...over,
})
async function insertRows(rows: ReturnType<typeof gatewayRow>[]) {
  for (const r of rows) {
    await db`
      INSERT INTO usage.records (source, source_id, grain, ts, billing, account, cost_usd, lane_detail)
      VALUES (${r.source}, ${r.id}, 'message', ${r.ts}::timestamptz, ${r.billing}, ${r.account},
              ${r.cost_usd}, ${JSON.stringify(r.lane_detail)}::text::jsonb)`
  }
}

beforeEach(async () => {
  db = await pg.reset()
  state.data = {}
  state.status = {}
  state.seen = []
  state.refreshed = '2026-11-02T08:00:00Z'
})

describePg('credit pass: platform_cost (Postgres, fake Admin API)', () => {
  test('cents become USD, pages are followed, null model/api_key_id groups are rows, the request shape is the spike’s', async () => {
    state.data['iu-key'] = [
      { day: '2026-10-30', model: 'claude-haiku-5-5', key: 'apikey_1', amount: '1234.567890' },
      { day: '2026-10-30', model: 'claude-sonnet-5-5', key: 'apikey_1', amount: '50.000000' },
      { day: '2026-10-30', model: null, key: null, amount: '0.500000' },
      { day: '2026-10-31', model: 'claude-haiku-5-5', key: null, amount: '10.000001' },
      { day: '2026-10-31', model: null, key: 'apikey_2', amount: '7' },
    ]
    const res = await run([IU])
    expect(res.platformCost).toBe(5)
    expect(await costOf('iu')).toEqual([
      expect.objectContaining({
        day: '2026-10-30',
        model: null,
        api_key_id: null,
        cost_usd: 0.005,
      }),
      expect.objectContaining({
        day: '2026-10-30',
        model: 'claude-haiku-5-5',
        api_key_id: 'apikey_1',
        cost_usd: 12.3456789,
      }),
      expect.objectContaining({
        day: '2026-10-30',
        model: 'claude-sonnet-5-5',
        api_key_id: 'apikey_1',
        cost_usd: 0.5,
      }),
      expect.objectContaining({
        day: '2026-10-31',
        model: null,
        api_key_id: 'apikey_2',
        cost_usd: 0.07,
      }),
      expect.objectContaining({
        day: '2026-10-31',
        model: 'claude-haiku-5-5',
        api_key_id: null,
        cost_usd: 0.10000001,
      }),
    ])
    // refreshed_at is the response's data_refreshed_at
    const [{ n }] =
      await db`SELECT count(*)::int AS n FROM usage.platform_cost WHERE refreshed_at = '2026-11-02T08:00:00Z'`
    expect(n).toBe(5)

    const first = state.seen[0]!
    expect(first.url.pathname).toBe('/v1/organizations/analytics/cost')
    expect(first.url.searchParams.get('time_bucket_width')).toBe('1d')
    expect(first.url.searchParams.getAll('group_by[]')).toEqual(['api_key_id', 'model'])
    expect(first.url.searchParams.get('limit')).toBe('1000')
    expect(first.headers.get('anthropic-beta')).toBe('analytics-usage-cost-2026-08-24')
    expect(first.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(first.headers.get('x-api-key')).toBe('iu-key')
    // paging happened (2 rows per page, 3 pages for the window holding all five rows)
    expect(state.seen.filter((s) => s.url.searchParams.get('page')).length).toBeGreaterThan(0)
    // the window is split into requests of at most 31 days
    for (const s of state.seen) {
      const span =
        Date.parse(s.url.searchParams.get('ending_at')!) -
        Date.parse(s.url.searchParams.get('starting_at')!)
      expect(span).toBeLessThanOrEqual(31 * 86_400_000)
    }
  })

  test('a re-run upserts: no duplicate rows, a revised amount and a newer snapshot replace the old', async () => {
    state.data['iu-key'] = [{ day: '2026-10-30', model: 'm', key: 'k', amount: '100' }]
    await run([IU])
    state.data['iu-key'] = [{ day: '2026-10-30', model: 'm', key: 'k', amount: '150' }]
    state.refreshed = '2026-11-02T09:00:00Z'
    await run([IU])
    const rows = await costOf('iu')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(expect.objectContaining({ cost_usd: 1.5 }))
    expect(new Date(rows[0].refreshed_at).toISOString()).toBe('2026-11-02T09:00:00.000Z')
  })

  test('a 4xx skips that org without aborting the next; a placeholder ref makes no request', async () => {
    state.status['me-key'] = 403
    state.data['iu-key'] = [{ day: '2026-10-30', model: 'm', key: 'k', amount: '100' }]
    const res = await run([ME, ME2, IU])
    expect(res.platformCost).toBe(1)
    expect(await costOf('me')).toEqual([])
    expect((await costOf('iu')).length).toBe(1)
    expect(state.seen.map((s) => s.key)).not.toContain('')
    expect(state.seen.some((s) => s.key === 'me-key')).toBe(true)
    // me's cycles still carry the metered figure even though the Admin API refused
    expect((await cycles('me')).length).toBe(2)
  })

  test('the admin key never appears in an error', async () => {
    state.status['SECRET-KEY-123'] = 401
    const window = [
      { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') },
    ]
    const err = await fetchCost(window, { baseUrl, adminKey: 'SECRET-KEY-123' }).catch((e) => e)
    expect(err).toBeInstanceOf(AdminApiError)
    expect(String(err.message)).toBe('HTTP 401')
    const refused = await fetchCost(window, {
      baseUrl: 'http://localhost:1',
      adminKey: 'SECRET-KEY-123',
    }).catch((e) => e)
    expect(refused).toBeInstanceOf(AdminApiError)
    expect(String(refused.message)).not.toContain('SECRET-KEY-123')
  })
})

describePg('credit pass: credit_cycles (Postgres)', () => {
  test('metered counts gateway api_credit rows of the account in [start, end) only', async () => {
    await insertRows([
      gatewayRow('g1', { cost_usd: 1.5 }),
      gatewayRow('g2', { lane_detail: { costEstimatedUsd: 0.25 } }), // estimated charge, no reported cost
      gatewayRow('g3', { cost_usd: 2, lane_detail: { costEstimatedUsd: 99 } }), // the reported cost wins
      gatewayRow('g4', {}), // neither: counts 0
      gatewayRow('aw1', { source: 'agent-workflows', cost_usd: 10 }), // not the gateway
      gatewayRow('mx1', { billing: 'max', cost_usd: 7 }), // Max window, not credit
      gatewayRow('me1', { account: 'me', cost_usd: 5 }), // another account
      gatewayRow('before', { ts: '2026-10-20T23:59:59Z', cost_usd: 3 }), // previous cycle
      gatewayRow('edge', { ts: '2026-10-21T00:00:00Z', cost_usd: 4 }), // the expiry instant belongs to the new cycle
    ])
    await run([IU])
    const [prev, cur] = await cycles('iu')
    expect(cur).toEqual(
      expect.objectContaining({
        grant: 200.0,
        metered: 7.75,
        reconciled: null,
        unspent: null,
        closed_at: null,
      }),
    )
    expect(prev.metered).toBe(3)
    expect(new Date(cur.cycle_start).toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(new Date(cur.cycle_end).toISOString()).toBe('2026-11-21T00:00:00.000Z')
  })

  test('a cycle closes only once the provider snapshot has passed its end', async () => {
    state.data['iu-key'] = [
      { day: '2026-09-20', model: 'm', key: 'k', amount: '9999' }, // before the cycle
      { day: '2026-09-21', model: 'm', key: 'k', amount: '5000' }, // 50 USD
      { day: '2026-10-20', model: 'm', key: 'k', amount: '2500' }, // 25 USD, last day of the cycle
      { day: '2026-10-21', model: 'm', key: 'k', amount: '1000' }, // next cycle
    ]
    state.refreshed = '2026-10-20T23:00:00Z' // before the previous cycle's end (Oct 21)
    await run([IU])
    let [prev, cur] = await cycles('iu')
    expect(prev).toEqual(
      expect.objectContaining({ reconciled: null, unspent: null, closed_at: null }),
    )
    expect(cur.closed_at).toBeNull()

    state.refreshed = '2026-10-21T00:00:00Z' // exactly at the end: the snapshot covers it
    await run([IU])
    ;[prev, cur] = await cycles('iu')
    expect(prev.reconciled).toBe(75)
    expect(prev.unspent).toBe(125)
    expect(prev.closed_at).not.toBeNull()
    // the open cycle never reconciles
    expect(cur).toEqual(
      expect.objectContaining({ reconciled: null, unspent: null, closed_at: null }),
    )
  })

  test('unspent never goes below zero; closed_at is set once; revisions follow for 7 days, then freeze', async () => {
    state.data['iu-key'] = [{ day: '2026-10-01', model: 'm', key: 'k', amount: '25000' }] // 250 USD > 200 grant
    state.refreshed = '2026-10-22T00:00:00Z'
    await run([IU], { now: new Date('2026-10-22T01:00:00Z') })
    let [prev] = await cycles('iu')
    expect(prev.reconciled).toBe(250)
    expect(prev.unspent).toBe(0)
    const closedAt = new Date(prev.closed_at).toISOString()
    expect(closedAt).toBe('2026-10-22T01:00:00.000Z')

    state.data['iu-key'] = [{ day: '2026-10-01', model: 'm', key: 'k', amount: '15000' }] // revised to 150 USD
    state.refreshed = '2026-10-25T00:00:00Z'
    await run([IU], { now: new Date('2026-10-25T01:00:00Z') })
    ;[prev] = await cycles('iu')
    expect(prev.reconciled).toBe(150)
    expect(prev.unspent).toBe(50)
    expect(new Date(prev.closed_at).toISOString()).toBe(closedAt)

    state.data['iu-key'] = [{ day: '2026-10-01', model: 'm', key: 'k', amount: '10000' }]
    state.refreshed = '2026-10-30T00:00:00Z'
    await run([IU], { now: new Date('2026-10-30T01:00:00Z') }) // 9 days after the end
    ;[prev] = await cycles('iu')
    expect(prev.reconciled).toBe(150)
    expect(new Date(prev.closed_at).toISOString()).toBe(closedAt)
  })

  test('a quiet org (no cost rows at all) still closes its cycle: unspent is the whole grant', async () => {
    await run([IU])
    const [prev, cur] = await cycles('iu')
    expect(prev).toEqual(expect.objectContaining({ reconciled: 0.0, unspent: 200.0 }))
    expect(prev.closed_at).not.toBeNull()
    expect(cur.closed_at).toBeNull()
  })

  test('cycleDay 27 and 21 side by side across a month end; null cycleDay writes platform_cost but no cycles', async () => {
    secrets['ref-me2'] = 'me2-key'
    try {
      state.data['me2-key'] = [{ day: '2026-10-30', model: 'm', key: 'k', amount: '100' }]
      const now = new Date('2026-11-02T10:00:00Z')
      await run([ME, IU, ME2], { now })
    } finally {
      secrets['ref-me2'] = null
    }
    const me = await cycles('me')
    expect(me.map((c: { cycle_start: Date }) => new Date(c.cycle_start).toISOString())).toEqual([
      '2026-09-27T00:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ])
    expect(me.map((c: { cycle_end: Date }) => new Date(c.cycle_end).toISOString())).toEqual([
      '2026-10-27T00:00:00.000Z',
      '2026-11-27T00:00:00.000Z',
    ])
    expect((await cycles('iu')).length).toBe(2)
    expect(await cycles('me2')).toEqual([])
    expect((await costOf('me2')).length).toBe(1)
  })

  test('metered is refreshed on every pass', async () => {
    await run([IU])
    await insertRows([gatewayRow('g1', { cost_usd: 4 })])
    await run([IU])
    expect((await cycles('iu'))[1].metered).toBe(4)
  })
})

describePg('credit pass: wired into ingest (Postgres)', () => {
  test('a failing pass is logged and the ingest still returns', async () => {
    // cycleDay 99 throws inside the pass
    const bad: PlatformAccount = { id: 'iu', creditUsd: 1, cycleDay: 99, adminKeyRef: null }
    const summary = await runIngest(db, {
      collectors: [],
      accounts: false,
      portal: false,
      credit: { accounts: [bad], resolveSecret, baseUrl, now: NOW },
    })
    expect(summary.results).toEqual([])
  })

  test('the pass runs after the collectors in a run that asks for it', async () => {
    state.data['iu-key'] = [{ day: '2026-10-30', model: 'm', key: 'k', amount: '100' }]
    await runIngest(db, {
      collectors: [],
      accounts: false,
      portal: false,
      credit: { accounts: [IU], resolveSecret, baseUrl, now: NOW },
    })
    expect((await costOf('iu')).length).toBe(1)
    expect((await cycles('iu')).length).toBe(2)
  })

  test('a narrowed run (--source / injected collectors) skips the pass by default', async () => {
    await runIngest(db, { collectors: [], accounts: false, portal: false })
    expect(await cycles('iu')).toEqual([])
  })
})
