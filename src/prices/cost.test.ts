import { describe, expect, test } from 'bun:test'
import { scratchDb, describePg } from '../pg/testing.ts'
import { migrate } from '../pg/migrate.ts'
import { costFor, inOffPeak, type OverrideRow, type PriceBook, type TokenCounts } from './cost.ts'
import { normalizeLiteLLM } from './normalize.ts'
import { syncPrices } from './sync.ts'
import { fixtureBook, fixtureDeps, FIXTURE_SINCE } from './testing.ts'
import { loadPriceBook } from './store.ts'

const M = (n: Partial<TokenCounts>): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...n,
})
const ALL_KINDS_1M = M({
  input: 1e6,
  output: 1e6,
  cacheRead: 1e6,
  cacheWrite5m: 1e6,
  cacheWrite1h: 1e6,
})
const T = (iso: string) => new Date(iso)
const WED_PEAK = T('2026-10-28T06:46:00Z')
const WED_OFF = T('2026-10-28T17:17:00Z')
const SAT = T('2026-10-31T03:00:00Z')

interface Case {
  name: string
  model: string | null
  ts: Date
  tokens: TokenCounts
  grain?: 'message' | 'session'
  reportedUsd?: number | null
  usd: number | null
  source: 'reported' | 'prices' | 'override' | 'none'
}

// Hand-computed expectations (USD): each is checked by the pure TypeScript path and, with Postgres, by
// usage.compute_cost on the same fixture rows.
const CASES: Case[] = [
  {
    name: 'sonnet 5.5, 1M of each of the five kinds',
    model: 'claude-sonnet-5-5',
    ts: WED_OFF,
    tokens: ALL_KINDS_1M,
    usd: 18.6,
    source: 'prices',
  },
  {
    name: 'the [1m] alias prices as the base model',
    model: 'claude-sonnet-5[1m]',
    ts: WED_OFF,
    tokens: M({ input: 1e6 }),
    usd: 2,
    source: 'prices',
  },
  {
    name: 'haiku 5.5 below its 100k tier',
    model: 'claude-haiku-5-5',
    ts: WED_OFF,
    tokens: M({ input: 50_000, output: 1000 }),
    usd: 0.0055,
    source: 'prices',
  },
  {
    name: 'haiku 5.5 above 100k reprices all kinds',
    model: 'claude-haiku-5-5',
    ts: WED_OFF,
    tokens: M({ input: 150_000, output: 1000, cacheRead: 10_000 }),
    usd: 0.075 + 0.0025 + 0.0005,
    source: 'prices',
  },
  {
    name: 'a session row never takes the long-context tier',
    model: 'claude-haiku-5-5',
    ts: WED_OFF,
    tokens: M({ input: 150_000, output: 1000 }),
    grain: 'session',
    usd: 0.0155,
    source: 'prices',
  },
  {
    name: 'deepseek peak (wednesday 06:46Z)',
    model: 'deepseek-v4.1-flash',
    ts: WED_PEAK,
    tokens: M({ input: 1e6, output: 1e6, cacheRead: 1e6 }),
    usd: 0.3 + 1.2 + 0.006,
    source: 'prices',
  },
  {
    name: 'deepseek off-peak (wednesday 17:17Z)',
    model: 'deepseek-v4.1-flash',
    ts: WED_OFF,
    tokens: M({ input: 1e6, output: 1e6, cacheRead: 1e6 }),
    usd: 0.15 + 0.6 + 0.003,
    source: 'prices',
  },
  {
    name: 'deepseek weekend is off-peak all day',
    model: 'deepseek-v4-flash',
    ts: SAT,
    tokens: M({ input: 1e6 }),
    usd: 0.15,
    source: 'prices',
  },
  {
    name: 'unpublished cache-write bills as input, 1h as 5m',
    model: 'deepseek-v4-flash',
    ts: WED_PEAK,
    tokens: M({ cacheWrite5m: 1e6, cacheWrite1h: 1e6 }),
    usd: 0.6,
    source: 'prices',
  },
  {
    name: 'reasoning tokens bill at the output rate',
    model: 'claude-opus-5-5',
    ts: WED_OFF,
    tokens: M({ output: 1e6, reasoning: 1e6 }),
    usd: 40,
    source: 'prices',
  },
  {
    name: 'openai long-context tier above 272k',
    model: 'gpt-5.6-terra',
    ts: WED_OFF,
    tokens: M({ input: 300_000, output: 1e6 }),
    usd: 1.2 + 18,
    source: 'prices',
  },
  {
    name: 'openrouter fallback model',
    model: 'hy3',
    ts: T('2026-10-28T12:00:00Z'),
    tokens: M({ input: 1e6 }),
    usd: 0.132,
    source: 'prices',
  },
  {
    name: 'openrouter time-of-day override becomes an off-peak window',
    model: 'hy3',
    ts: WED_OFF,
    tokens: M({ input: 1e6 }),
    usd: 0.0825,
    source: 'prices',
  },
  {
    name: 'provider-reported cost wins verbatim',
    model: 'claude-sonnet-5-5',
    ts: WED_OFF,
    tokens: ALL_KINDS_1M,
    reportedUsd: 1.234,
    usd: 1.234,
    source: 'reported',
  },
  {
    name: 'an unknown model is NULL, never 0',
    model: 'claude-does-not-exist-9',
    ts: WED_OFF,
    tokens: ALL_KINDS_1M,
    usd: null,
    source: 'none',
  },
  {
    name: 'a model with no name is NULL',
    model: null,
    ts: WED_OFF,
    tokens: M({ input: 5 }),
    usd: null,
    source: 'none',
  },
  {
    name: 'before the first row the first row stands in',
    model: 'claude-sonnet-5-5',
    ts: T('2026-05-01T00:00:00Z'),
    tokens: M({ input: 1e6 }),
    usd: 2,
    source: 'prices',
  },
]

function expectCase(c: Case, got: { costUsd: number | null; costSource: string }) {
  expect(got.costSource).toBe(c.source)
  if (c.usd === null) expect(got.costUsd).toBeNull()
  else expect(got.costUsd).toBeCloseTo(c.usd, 9)
}

describe('costFor (pure)', () => {
  const book = fixtureBook()
  for (const c of CASES) {
    test(c.name, () => {
      expectCase(
        c,
        costFor(book, c.model, c.ts, c.tokens, { grain: c.grain, reportedUsd: c.reportedUsd }),
      )
    })
  }

  const override = (over: Partial<OverrideRow>): OverrideRow => ({
    id: 1,
    model: 'claude-sonnet-5-5',
    validFrom: T('2026-10-10T00:00:00Z'),
    validTo: null,
    supersedesPrices: false,
    schedule: normalizeLiteLLM({ input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 })!,
    ...over,
  })
  const withOverride = (o: OverrideRow, base: PriceBook = fixtureBook()): PriceBook => ({
    ...base,
    overrides: [o],
  })

  test('an override fills a model the catalog does not price', () => {
    const book = withOverride(override({ model: 'mystery-model' }))
    expect(costFor(book, 'mystery-model', WED_OFF, M({ input: 1e6 }))).toMatchObject({
      costUsd: 9,
      costSource: 'override',
    })
  })

  test('a plain override loses to the catalog row, a superseding one wins inside its window', () => {
    const plain = withOverride(override({}))
    expect(costFor(plain, 'claude-sonnet-5-5', WED_OFF, M({ input: 1e6 })).costSource).toBe(
      'prices',
    )
    const forced = withOverride(
      override({ supersedesPrices: true, validTo: T('2026-10-30T00:00:00Z') }),
    )
    expect(costFor(forced, 'claude-sonnet-5-5', WED_OFF, M({ input: 1e6 }))).toMatchObject({
      costUsd: 9,
      costSource: 'override',
    })
    expect(
      costFor(forced, 'claude-sonnet-5-5', T('2026-10-31T00:00:00Z'), M({ input: 1e6 })).costSource,
    ).toBe('prices')
    expect(
      costFor(forced, 'claude-sonnet-5-5', T('2026-10-09T00:00:00Z'), M({ input: 1e6 })).costSource,
    ).toBe('prices')
  })

  test('reported cost beats even a superseding override', () => {
    const forced = withOverride(override({ supersedesPrices: true }))
    expect(
      costFor(forced, 'claude-sonnet-5-5', WED_OFF, M({ input: 1e6 }), { reportedUsd: 0.5 })
        .costSource,
    ).toBe('reported')
  })

  test('a later catalog row takes over from its valid_from', () => {
    const base = fixtureBook()
    const cheaper = normalizeLiteLLM({ input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 })!
    const book: PriceBook = {
      ...base,
      prices: [
        ...base.prices,
        {
          id: 999,
          modelKey: 'claude-sonnet-5-5',
          validFrom: T('2026-10-20T00:00:00Z'),
          schedule: cheaper,
        },
      ],
    }
    expect(
      costFor(book, 'claude-sonnet-5-5', T('2026-10-19T00:00:00Z'), M({ input: 1e6 })).costUsd,
    ).toBe(2)
    expect(
      costFor(book, 'claude-sonnet-5-5', T('2026-10-21T00:00:00Z'), M({ input: 1e6 })),
    ).toMatchObject({ costUsd: 1, priceId: 999 })
  })

  test('off-peak windows wrap midnight and honour ISO weekdays', () => {
    const op = { rates: {}, windows: [{ hours_utc: ['22:00-02:00'], weekdays: [1] }] }
    expect(inOffPeak(op, T('2026-10-26T23:00:00Z'))).toBe(true) // monday 23:00
    expect(inOffPeak(op, T('2026-10-26T01:00:00Z'))).toBe(true)
    expect(inOffPeak(op, T('2026-10-26T12:00:00Z'))).toBe(false)
    expect(inOffPeak(op, T('2026-10-27T23:00:00Z'))).toBe(false) // tuesday
    expect(inOffPeak(op, T('2026-11-01T23:00:00Z'))).toBe(false) // sunday = 7
  })
})

describePg('usage.compute_cost agrees with the TypeScript twin', () => {
  const db = scratchDb()

  test('every fixture case', async () => {
    const sql = await db.connect()
    await migrate(sql)
    // These cases pin the catalog path; the IU overrides migration 0005 ships are tested in iu-overrides.test.ts.
    await sql`DELETE FROM usage.price_overrides`
    await syncPrices(sql, fixtureDeps())
    const book = await loadPriceBook(sql)
    for (const c of CASES) {
      const t = c.tokens
      const [row] = await sql`
        SELECT cost_usd::float8 AS cost_usd, cost_source FROM usage.compute_cost(
          ${c.model}::text, ${c.ts}::timestamptz, ${t.input}::bigint, ${t.output}::bigint, ${t.cacheRead}::bigint,
          ${t.cacheWrite5m}::bigint, ${t.cacheWrite1h}::bigint, ${t.reasoning ?? 0}::bigint, ${c.grain ?? 'message'}::text,
          ${c.reportedUsd ?? null}::numeric)`
      expectCase(c, { costUsd: row.cost_usd, costSource: row.cost_source })
      const pure = costFor(book, c.model, c.ts, t, { grain: c.grain, reportedUsd: c.reportedUsd })
      expect(pure.costSource).toBe(row.cost_source)
      if (pure.costUsd !== null) expect(row.cost_usd).toBeCloseTo(pure.costUsd, 9)
    }
  })

  test('override precedence in SQL', async () => {
    const sql = await db.connect()
    await sql`INSERT INTO usage.price_overrides (model, valid_from, input, output, reason)
              VALUES ('mystery-model', ${FIXTURE_SINCE}, 9, 9, 'test fill')`
    await sql`INSERT INTO usage.price_overrides (model, valid_from, valid_to, input, output, supersedes_prices, reason)
              VALUES ('claude-sonnet-5-5', '2026-10-10', '2026-10-30', 9, 9, true, 'test supersede')`
    const cost = async (model: string, ts: string) => {
      const [r] =
        await sql`SELECT cost_usd::float8 AS c, cost_source AS s FROM usage.compute_cost(${model}, ${ts}::timestamptz, 1000000, 0, 0, 0, 0)`
      return [r.c, r.s]
    }
    expect(await cost('mystery-model', '2026-10-28T12:00:00Z')).toEqual([9, 'override'])
    expect(await cost('claude-sonnet-5-5', '2026-10-28T12:00:00Z')).toEqual([9, 'override'])
    expect(await cost('claude-sonnet-5-5', '2026-10-31T12:00:00Z')).toEqual([2, 'prices'])
    const book = await loadPriceBook(sql)
    expect(
      costFor(book, 'claude-sonnet-5-5', T('2026-10-28T12:00:00Z'), M({ input: 1e6 })).costSource,
    ).toBe('override')
    expect(
      costFor(book, 'mystery-model', T('2026-10-28T12:00:00Z'), M({ input: 1e6 })).costUsd,
    ).toBe(9)
  })

  test('the schema refuses a zero price', async () => {
    const sql = await db.connect()
    const insertZero = async () => {
      await sql`INSERT INTO usage.prices (model_key, valid_from, input, output, source) VALUES ('zero', now(), 0, 1, 'litellm')`
    }
    await expect(insertZero()).rejects.toThrow()
  })
})
