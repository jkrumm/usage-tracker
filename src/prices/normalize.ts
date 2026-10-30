// Catalog entry -> price schedule. Rates are decimal strings in USD per 1M tokens, derived from the
// catalogs' per-token numbers by shifting the decimal point of their shortest printed form, so there is no
// float drift (1e-7 * 1e6 = 0.09999999999999999 in doubles; here it is "0.1").

export const KINDS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const
export type Kind = (typeof KINDS)[number]

export interface Rates {
  input: string
  output: string
  cache_read: string | null
  cache_write_5m: string | null
  cache_write_1h: string | null
}
/** Replaces the listed kinds when a prompt exceeds above_tokens; unlisted kinds keep the base rate. */
export type Tier = { above_tokens: number } & Partial<Record<Kind, string>>
export interface OffPeak {
  rates: Partial<Record<Kind, string>>
  windows: { hours_utc: string[]; weekdays: number[] }[]
}
export interface Schedule {
  rates: Rates
  batch: Partial<Record<Kind, string>> | null
  tiers: Tier[] | null
  offPeak: OffPeak | null
}

/** Strip leading/trailing zeros of a plain decimal string ("2.500" -> "2.5", "007" -> "7"). */
export function canonDecimal(s: string): string {
  const [i = '0', f = ''] = s.trim().split('.')
  const frac = f.replace(/0+$/, '')
  const int = i.replace(/^0+(?=\d)/, '') || '0'
  return frac ? `${int}.${frac}` : int
}

/** The decimal value of x * 10^shift, exact for the shortest representation of x. */
export function shiftDecimal(x: number, shift: number): string {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x))
  if (!m) throw new Error(`not a plain positive number: ${x}`)
  const [, int = '0', frac = '', exp = '0'] = m
  const digits = int + frac
  const point = int.length + Number(exp) + shift
  if (point <= 0) return canonDecimal(`0.${'0'.repeat(-point)}${digits}`)
  if (point >= digits.length) return canonDecimal(digits + '0'.repeat(point - digits.length))
  return canonDecimal(`${digits.slice(0, point)}.${digits.slice(point)}`)
}

/** Per-token number -> per-1M decimal string, or null when absent, non-numeric or not positive. */
export function perMillion(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  return shiftDecimal(n, 6)
}

const LITELLM_FIELDS: Record<string, Kind> = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cache_read',
  cache_creation_input_token_cost: 'cache_write_5m',
  cache_creation_input_token_cost_above_1hr: 'cache_write_1h',
}

function pick(entry: Record<string, unknown>, suffix = ''): Partial<Record<Kind, string>> {
  const out: Partial<Record<Kind, string>> = {}
  for (const [field, kind] of Object.entries(LITELLM_FIELDS)) {
    const v = perMillion(entry[field + suffix])
    if (v) out[kind] = v
  }
  return out
}

function tiersOf(entry: Record<string, unknown>): Tier[] | null {
  const byThreshold = new Map<number, Tier>()
  for (const [field, value] of Object.entries(entry)) {
    const m = /^(.+)_above_(\d+)k_tokens$/.exec(field)
    const kind = m ? LITELLM_FIELDS[m[1] as string] : undefined
    const rate = perMillion(value)
    if (!m || !kind || !rate) continue
    const above = Number(m[2]) * 1000
    const tier = byThreshold.get(above) ?? { above_tokens: above }
    tier[kind] = rate
    byThreshold.set(above, tier)
  }
  return byThreshold.size > 0
    ? [...byThreshold.values()].sort((a, b) => a.above_tokens - b.above_tokens)
    : null
}

function offPeakOf(entry: Record<string, unknown>): OffPeak | null {
  const op = entry.off_peak_pricing
  if (!op || typeof op !== 'object') return null
  const o = op as Record<string, unknown>
  const rates = pick(o)
  const windows = (Array.isArray(o.windows) ? o.windows : []).flatMap((w): OffPeak['windows'] => {
    const win = w as { hours_utc?: unknown; weekdays?: unknown }
    const hours = (Array.isArray(win.hours_utc) ? win.hours_utc : [win.hours_utc]).filter(
      (h): h is string => typeof h === 'string',
    )
    const weekdays = Array.isArray(win.weekdays)
      ? win.weekdays.filter((d): d is number => typeof d === 'number')
      : []
    return hours.length > 0 && weekdays.length > 0 ? [{ hours_utc: hours, weekdays }] : []
  })
  return Object.keys(rates).length > 0 && windows.length > 0 ? { rates, windows } : null
}

/** null = the entry has no usable input/output price (a zero or missing price is never stored). */
export function normalizeLiteLLM(entry: unknown): Schedule | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const base = pick(e)
  if (!base.input || !base.output) return null
  const batch = pick(e, '_batches')
  return {
    rates: {
      input: base.input,
      output: base.output,
      cache_read: base.cache_read ?? null,
      cache_write_5m: base.cache_write_5m ?? null,
      cache_write_1h: base.cache_write_1h ?? null,
    },
    batch: Object.keys(batch).length > 0 ? batch : null,
    tiers: tiersOf(e),
    offPeak: offPeakOf(e),
  }
}

export interface OpenRouterModel {
  id: string
  pricing?: Record<string, unknown>
}

const OPENROUTER_FIELDS: Record<string, Kind> = {
  prompt: 'input',
  completion: 'output',
  input_cache_read: 'cache_read',
  input_cache_write: 'cache_write_5m',
  input_cache_write_1h: 'cache_write_1h',
}
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

function openRouterRates(p: Record<string, unknown>): Partial<Record<Kind, string>> {
  const out: Partial<Record<Kind, string>> = {}
  for (const [field, kind] of Object.entries(OPENROUTER_FIELDS)) {
    const v = perMillion(p[field])
    if (v) out[kind] = v
  }
  return out
}

const hhmm = (n: number) =>
  `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`

/**
 * OpenRouter's time-of-day `overrides` become one off-peak overlay when every override that differs from the
 * base price shares one rate set; a more intricate schedule is left out and the base price stands.
 */
function openRouterOffPeak(
  p: Record<string, unknown>,
  base: Partial<Record<Kind, string>>,
): OffPeak | null {
  const overrides = (Array.isArray(p.overrides) ? p.overrides : []) as Record<string, unknown>[]
  const differing = overrides
    .map((o) => ({ o, rates: openRouterRates(o) }))
    .filter(({ rates }) => (Object.keys(rates) as Kind[]).some((k) => rates[k] !== base[k]))
  const first = differing[0]
  if (
    !first ||
    differing.some(({ rates }) => scheduleTextOf(rates) !== scheduleTextOf(first.rates))
  )
    return null
  const windows = differing.map(({ o }) => {
    const days = Array.isArray(o.utc_days)
      ? o.utc_days.map((d) => DAYS.indexOf(String(d)) + 1).filter((d) => d > 0)
      : [1, 2, 3, 4, 5, 6, 7]
    const start = typeof o.utc_start === 'number' ? o.utc_start : 0
    const end = typeof o.utc_end === 'number' ? o.utc_end : 0
    return { hours_utc: [`${hhmm(start)}-${hhmm(end)}`], weekdays: days }
  })
  return { rates: first.rates, windows }
}

const scheduleTextOf = (v: unknown): string => JSON.stringify(sortKeys(v))

/** OpenRouter publishes per-token decimal strings: prompt, completion, input_cache_read/_write(/_1h). */
export function normalizeOpenRouter(model: OpenRouterModel | undefined): Schedule | null {
  const p = model?.pricing
  if (!p) return null
  const r = openRouterRates(p)
  if (!r.input || !r.output) return null
  return {
    rates: {
      input: r.input,
      output: r.output,
      cache_read: r.cache_read ?? null,
      cache_write_5m: r.cache_write_5m ?? null,
      cache_write_1h: r.cache_write_1h ?? null,
    },
    batch: null,
    tiers: null,
    offPeak: openRouterOffPeak(p, r),
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    )
  }
  return v
}

/** Canonical text of a schedule: equal text = no price change. */
export function scheduleText(s: Schedule): string {
  return scheduleTextOf(s)
}

/** A rate the previous schedule published that the new one dropped (a vanished or newly-zero price). */
export function droppedRate(prev: Schedule, next: Schedule): Kind | null {
  return KINDS.find((k) => prev.rates[k] !== null && next.rates[k] === null) ?? null
}
