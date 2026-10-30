import type { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { migratedDb } from './pg/fixture.ts'
import { describePg } from './pg/testing.ts'
import { formatReprice, reprice } from './reprice.ts'

const pg = migratedDb()
let db: SQL

interface Seed {
  id?: string
  model?: string | null
  ts?: string
  input?: number
  output?: number
  reasoning?: number
  cost: number | null
  source: 'reported' | 'prices' | 'override' | 'none'
  reported?: number | null
  raw?: object | null
}

const INGESTED = '2026-08-02T00:00:00Z'

async function seed(s: Seed): Promise<void> {
  await db`
    INSERT INTO usage.records (source, source_id, grain, ts, model, billing, input_tokens, output_tokens, reasoning_tokens,
                               cost_usd, cost_source, cost_reported_usd, raw, ingested_at)
    VALUES ('hermes', ${s.id ?? 'a'}, 'message', ${s.ts ?? '2026-08-01T00:00:00Z'}::timestamptz, ${s.model === undefined ? 'gpt-5.6-luna' : s.model},
            'api_key', ${s.input ?? 100_000}, ${s.output ?? 100_000}, ${s.reasoning ?? 0}, ${s.cost}, ${s.source}, ${s.reported ?? null},
            ${s.raw ? JSON.stringify(s.raw) : null}::text::jsonb, ${INGESTED}::timestamptz)`
}

const price = (key: string, input: number, output: number, cacheRead: number | null = null) =>
  db`INSERT INTO usage.prices (model_key, valid_from, input, output, cache_read, source)
     VALUES (${key}, '2026-01-01T00:00:00Z', ${input}, ${output}, ${cacheRead}, 'seed-git')`

const stored = async (id = 'a') =>
  (
    await db`SELECT cost_usd::float8 AS cost, cost_source AS source, price_id, ingested_at::text AS ingested FROM usage.records WHERE source_id = ${id}`
  )[0]!

beforeEach(async () => {
  db = await pg.reset()
  await db`TRUNCATE usage.prices, usage.price_overrides, usage.price_aliases RESTART IDENTITY CASCADE`
  await price('gpt-5.6-luna', 0.2, 1.2, 0.02)
})

describePg('reprice', () => {
  test('rewrites a row priced at a stale rate and points it at the price row', async () => {
    await seed({ cost: 0.07, source: 'prices' }) // an older luna rate: $0.10/$0.60
    const ingestedBefore = (await stored()).ingested
    const result = await reprice(db)

    expect(result).toMatchObject({
      scanned: 1,
      changed: 1,
      preserved: 0,
      reportedSkipped: 0,
      dryRun: false,
    })
    const row = await stored()
    expect(row.cost).toBeCloseTo(0.14, 10) // $0.20 in + $1.20 out, per 100k each
    expect(row.source).toBe('prices')
    expect(row.price_id).not.toBeNull()
    expect(row.ingested).toBe(ingestedBefore) // a reprice is not an ingest
  })

  test('leaves an already-correct row alone', async () => {
    await seed({ cost: 0.14, source: 'prices' })
    expect((await reprice(db)).changed).toBe(1) // first pass links the price row
    const again = await reprice(db)
    expect(again.changed).toBe(0)
    expect(formatReprice(again)).toContain('everything already matches')
  })

  test('prices a row the prices could not cover before', async () => {
    await seed({ cost: null, source: 'none' })
    expect((await reprice(db)).changed).toBe(1)
    expect((await stored()).source).toBe('prices')
  })

  test('dry run reports rows and dollars per model without writing', async () => {
    await seed({ cost: 0.7, source: 'prices' })
    const result = await reprice(db, { dryRun: true })

    expect(result.changed).toBe(1)
    expect(result.dryRun).toBe(true)
    expect(result.models).toEqual([
      { model: 'gpt-5.6-luna', changed: 1, oldCostUsd: 0.7, newCostUsd: 0.14 },
    ])
    expect(formatReprice(result)).toContain('would reprice 1 of 1 rows')
    expect((await stored()).cost).toBe(0.7)
  })

  test('--model narrows the scan', async () => {
    await seed({ cost: 0.7, source: 'prices', model: 'some-unpriced-model' })
    const result = await reprice(db, { model: 'gpt-5.6-luna' })
    expect(result.scanned).toBe(0)
    expect(result.changed).toBe(0)
  })

  test('an override is applied and recorded as the source, with no price row', async () => {
    await db`INSERT INTO usage.price_overrides (model, valid_from, input, output, supersedes_prices, reason)
             VALUES ('gpt-5.6-luna', '2026-01-01T00:00:00Z', 1, 2, true, 'test')`
    await seed({ cost: 0.14, source: 'prices' })
    expect((await reprice(db)).changed).toBe(1)
    const row = await stored()
    expect(row.cost).toBeCloseTo(0.3, 10) // 100k at $1 + 100k at $2
    expect(row).toMatchObject({ source: 'override', price_id: null })
  })
})

describePg('reprice — provider-reported cost', () => {
  test('never rewrites a row that carries cost_reported_usd, even for a priced model', async () => {
    // Priced model: without the guard this row would be recomputed to 0.14; the vendor's per-call cost must survive.
    await seed({ cost: 0.42, source: 'reported', reported: 0.42 })
    const result = await reprice(db)

    expect(result).toMatchObject({ scanned: 0, changed: 0, reportedSkipped: 1 })
    expect(await stored()).toMatchObject({ cost: 0.42, source: 'reported' })
    expect(formatReprice(result)).toContain('provider-reported')
  })
})

describePg('reprice — prices removed', () => {
  test('never rewrites a priced row to unpriced', async () => {
    await seed({ cost: 5.25, source: 'prices', model: 'gemini-3.1-flash-tts-preview' })
    const result = await reprice(db)

    expect(result).toMatchObject({ changed: 0, preserved: 1 })
    expect(await stored()).toMatchObject({ cost: 5.25, source: 'prices' })
  })

  test('an unpriced row of an unpriced model stays unpriced', async () => {
    await seed({ cost: null, source: 'none', model: 'gemma4-agent' })
    expect(await reprice(db)).toMatchObject({ changed: 0, preserved: 0 })
    expect(await stored()).toMatchObject({ cost: null, source: 'none' })
  })
})

describePg('reprice — IU rules', () => {
  test("sonar is token-priced: Perplexity's list price is not what IU bills", async () => {
    await price('sonar', 1, 1)
    // The writer stores sonar without cost_reported_usd, so a row still carrying the vendor figure is repriced.
    await seed({ cost: 0.06, source: 'reported', model: 'sonar' })
    expect((await reprice(db)).changed).toBe(1)
    const row = await stored()
    expect(row.cost).toBeCloseTo(0.2, 10) // $1/M in and out, 100k each
    expect(row.source).toBe('prices')
  })

  test('reasoning IU did not bill stays unbilled: gpt-5.6-terra before 2026-10-16T08:55Z', async () => {
    await price('gpt-5.6-terra', 2, 12)
    // As the writer stores them: 0 reasoning tokens and the count in raw.reasoningTokensUnbilled before the cutoff.
    await seed({
      id: 'before',
      model: 'gpt-5.6-terra',
      ts: '2026-10-15T12:00:00Z',
      input: 0,
      output: 0,
      reasoning: 0,
      raw: { reasoningTokensUnbilled: 1_000_000 },
      cost: 99,
      source: 'prices',
    })
    await seed({
      id: 'after',
      model: 'gpt-5.6-terra',
      ts: '2026-10-17T12:00:00Z',
      input: 0,
      output: 0,
      reasoning: 1_000_000,
      cost: 99,
      source: 'prices',
    })

    expect((await reprice(db)).changed).toBe(2)
    expect((await stored('before')).cost).toBe(0)
    expect((await stored('after')).cost).toBeCloseTo(12, 8) // 1M reasoning at the output rate
    expect((await reprice(db)).changed).toBe(0)
  })
})
