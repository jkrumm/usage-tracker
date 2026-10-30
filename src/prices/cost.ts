import type { Kind, OffPeak, Schedule } from './normalize.ts'

// Pure twin of usage.price_at / usage.compute_cost (migrations/pg/0001_prices.sql). The two must agree on
// every fixture in cost.test.ts; change both together.

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** Billed at the output rate in addition to `output`. */
  reasoning?: number
}

export type CostSource = 'reported' | 'prices' | 'override' | 'none'
export interface CostResult {
  costUsd: number | null
  costSource: CostSource
  priceId: number | null
}

export interface PriceRow {
  id: number
  modelKey: string
  validFrom: Date
  schedule: Schedule
}
export interface OverrideRow {
  id: number
  model: string
  validFrom: Date
  validTo: Date | null
  supersedesPrices: boolean
  schedule: Schedule
}
export interface PriceBook {
  aliases: ReadonlyMap<string, string>
  prices: readonly PriceRow[]
  overrides: readonly OverrideRow[]
}
export interface ResolvedPrice {
  origin: 'prices' | 'override'
  priceId: number | null
  overrideId: number | null
  /** false = the model had no row yet at the time, so its first row stands in. */
  inForce: boolean
  schedule: Schedule
}

function activeOverride(
  book: PriceBook,
  model: string,
  ts: Date,
  supersedingOnly: boolean,
): OverrideRow | undefined {
  return book.overrides
    .filter(
      (o) =>
        o.model === model &&
        (!supersedingOnly || o.supersedesPrices) &&
        o.validFrom <= ts &&
        (o.validTo === null || ts < o.validTo),
    )
    .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())[0]
}

/** Precedence: a superseding override, else the catalog row in force, else any override, else null. */
export function priceAt(book: PriceBook, model: string, ts: Date): ResolvedPrice | null {
  const asOverride = (o: OverrideRow): ResolvedPrice => ({
    origin: 'override',
    priceId: null,
    overrideId: o.id,
    inForce: true,
    schedule: o.schedule,
  })

  const forced = activeOverride(book, model, ts, true)
  if (forced) return asOverride(forced)

  const key = book.aliases.get(model) ?? model
  const rows = book.prices
    .filter((p) => p.modelKey === key)
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
  const current = [...rows].reverse().find((p) => p.validFrom <= ts)
  const row = current ?? rows[0]
  if (row)
    return {
      origin: 'prices',
      priceId: row.id,
      overrideId: null,
      inForce: Boolean(current),
      schedule: row.schedule,
    }

  const fallback = activeOverride(book, model, ts, false)
  return fallback ? asOverride(fallback) : null
}

function minutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** Windows are UTC "HH:MM-HH:MM", [start, end); an end not after its start wraps midnight; weekdays are ISO. */
export function inOffPeak(offPeak: OffPeak | null, ts: Date): boolean {
  if (!offPeak) return false
  const dow = ts.getUTCDay() === 0 ? 7 : ts.getUTCDay()
  const minute = ts.getUTCHours() * 60 + ts.getUTCMinutes()
  return offPeak.windows.some(
    (w) =>
      w.weekdays.includes(dow) &&
      w.hours_utc.some((range) => {
        const [from = '0:0', to = '0:0'] = range.split('-')
        const s = minutes(from)
        const e = minutes(to)
        return s < e ? minute >= s && minute < e : minute >= s || minute < e
      }),
  )
}

type RateSet = Record<Kind, number | null>

const num = (v: string | undefined | null): number | null =>
  v === undefined || v === null ? null : Number(v)

/** Base rates, then the tier the prompt exceeds, then off-peak, then fallbacks for unpublished cache rates. */
export function effectiveRates(
  s: Schedule,
  ts: Date,
  tokens: TokenCounts,
  grain: 'message' | 'session',
): RateSet {
  const r: RateSet = {
    input: num(s.rates.input),
    output: num(s.rates.output),
    cache_read: num(s.rates.cache_read),
    cache_write_5m: num(s.rates.cache_write_5m),
    cache_write_1h: num(s.rates.cache_write_1h),
  }
  const overlay = (over: Partial<Record<Kind, string>>) => {
    for (const k of Object.keys(r) as Kind[]) r[k] = num(over[k]) ?? r[k]
  }

  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
  if (grain === 'message' && s.tiers) {
    const tier = s.tiers
      .filter((t) => prompt > t.above_tokens)
      .sort((a, b) => b.above_tokens - a.above_tokens)[0]
    if (tier) overlay(tier)
  }
  if (s.offPeak && inOffPeak(s.offPeak, ts)) overlay(s.offPeak.rates)

  r.cache_read ??= r.input
  r.cache_write_5m ??= r.input
  r.cache_write_1h ??= r.cache_write_5m
  return r
}

export function computeUsd(
  s: Schedule,
  ts: Date,
  tokens: TokenCounts,
  grain: 'message' | 'session' = 'message',
): number {
  const r = effectiveRates(s, ts, tokens, grain) as Record<Kind, number>
  return (
    (tokens.input * r.input +
      tokens.output * r.output +
      tokens.cacheRead * r.cache_read +
      tokens.cacheWrite5m * r.cache_write_5m +
      tokens.cacheWrite1h * r.cache_write_1h +
      (tokens.reasoning ?? 0) * r.output) /
    1_000_000
  )
}

/**
 * Provider-reported cost verbatim, else the catalog/override schedule, else null. An unpriced model is
 * cost_source 'none' with a NULL cost, never 0.
 */
export function costFor(
  book: PriceBook,
  model: string | null,
  ts: Date,
  tokens: TokenCounts,
  opts: { grain?: 'message' | 'session'; reportedUsd?: number | null } = {},
): CostResult {
  if (opts.reportedUsd !== undefined && opts.reportedUsd !== null) {
    return { costUsd: opts.reportedUsd, costSource: 'reported', priceId: null }
  }
  const price = model ? priceAt(book, model, ts) : null
  if (!price) return { costUsd: null, costSource: 'none', priceId: null }
  return {
    costUsd: computeUsd(price.schedule, ts, tokens, opts.grain ?? 'message'),
    costSource: price.origin === 'prices' ? 'prices' : 'override',
    priceId: price.priceId,
  }
}
