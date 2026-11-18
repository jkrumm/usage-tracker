import type { SQL } from 'bun'

// `window --fit`: how much of the Max 5 h / 7 d windows one weighted million tokens of each model family costs, measured
// from usage.window_intervals (points each window moved) and usage.records (tokens inside each interval). It replaces the
// assumption of the cost-weighted split (a window moves in proportion to dollars, docs/usage-schema.md §Window share) with
// a regression, per account and window: points moved in a 3 h bin = sum over families of (points per weighted Mtok x the
// family's weighted Mtok in the bin), least squares through the origin, 90 % interval from a seeded bootstrap over the bins.
// A read: nothing is stored.

export type Win = 'five_hour' | 'seven_day'

/** The family of a model id, in SQL (`r` is usage.records): `claude-<family>-...` -> `<family>`; anything else is its own family
 * (an id like `claude-3-opus` is `3`: the Claude 5 ids this reads are `claude-<family>-<n>`; the weekly report's `modelClass` is a coarser opus/sonnet split of its own). */
export const FAMILY_SQL = (r: string) =>
  `coalesce(substring(${r}.model from '^claude-([a-z]+)'), ${r}.model, '(unknown)')`

/**
 * Price-shaped weights, per million tokens: input 1, output 5, 5 min cache write 1.25, 1 h cache write 2, cache read 0.1.
 * The ratios of the catalog's list prices (docs/usage-schema.md §Prices), so a family's fitted weight reads as "points per
 * million input-token equivalents" and a window that followed API prices would give every family the same figure.
 */
const WEIGHTED_TOKENS_SQL = (r: string) =>
  `(${r}.input_tokens + 5 * ${r}.output_tokens + 1.25 * ${r}.cache_write_5m_tokens + 2 * ${r}.cache_write_1h_tokens + 0.1 * ${r}.cache_read_tokens) / 1e6`

/** The family every other family's weight is stated against (the middle tier). */
export const REFERENCE_FAMILY = 'sonnet'

const BIN_SECONDS = 3 * 3600
const BOOTSTRAP_RESAMPLES = 2000
/** 90 % interval. */
const LOW_Q = 0.05
const HIGH_Q = 0.95

export interface FitBin {
  /** Points the window moved in the bin. */
  y: number
  /** Weighted Mtok per family, same order as the families the bins were built for. */
  x: number[]
}

export interface WeightRow {
  account: string
  win: Win
  family: string
  /** Weighted Mtok behind the figure, over the whole period. */
  weightedMtok: number
  /** Points of the window per weighted Mtok; null when the fit could not be solved. */
  ptsPerMtok: number | null
  low: number | null
  high: number | null
  /** The 90 % interval lies above zero. */
  determined: boolean
  /** This family's weight over the reference family's; null unless both are determined. */
  relativeToReference: number | null
  /** Bins (3 h) the fit ran on. */
  bins: number
}

// ---------- the regression ----------

/** mulberry32: a seeded generator, so a report is a function of the database alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Least squares through the origin: solve (X'X) b = X'y by Gaussian elimination; null when the columns are collinear. */
export function solve(bins: readonly FitBin[], k: number): number[] | null {
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0))
  for (const bin of bins) {
    for (let i = 0; i < k; i++) {
      const row = a[i] as number[]
      const xi = bin.x[i] as number
      for (let j = 0; j < k; j++) row[j] = (row[j] as number) + xi * (bin.x[j] as number)
      row[k] = (row[k] as number) + xi * bin.y
    }
  }
  const scale = Math.max(1e-12, ...a.map((row, i) => Math.abs(row[i] as number)))
  for (let col = 0; col < k; col++) {
    let pivot = col
    for (let r = col + 1; r < k; r++)
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      )
        pivot = r
    const pivotRow = a[pivot] as number[]
    if (Math.abs(pivotRow[col] as number) < 1e-9 * scale) return null
    a[pivot] = a[col] as number[]
    a[col] = pivotRow
    for (let r = col + 1; r < k; r++) {
      const row = a[r] as number[]
      const f = (row[col] as number) / (pivotRow[col] as number)
      for (let c = col; c <= k; c++) row[c] = (row[c] as number) - f * (pivotRow[c] as number)
    }
  }
  const b = new Array<number>(k).fill(0)
  for (let i = k - 1; i >= 0; i--) {
    const row = a[i] as number[]
    let s = row[k] as number
    for (let j = i + 1; j < k; j++) s -= (row[j] as number) * (b[j] as number)
    b[i] = s / (row[i] as number)
  }
  return b
}

const quantile = (sorted: number[], q: number): number => {
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo)
}

export interface Fit {
  coef: number[] | null
  low: (number | null)[]
  high: (number | null)[]
}

/** Point estimate on all bins, interval from `resamples` bootstrap draws of the bins (a draw whose columns are collinear is skipped). */
export function fitBins(
  bins: readonly FitBin[],
  k: number,
  opts: { seed: string; resamples?: number | undefined },
): Fit {
  const none: Fit = {
    coef: null,
    low: new Array<number | null>(k).fill(null),
    high: new Array<number | null>(k).fill(null),
  }
  if (k === 0 || bins.length <= k) return none
  const coef = solve(bins, k)
  if (!coef) return none
  const draws: number[][] = Array.from({ length: k }, () => [])
  const next = rng(hash(opts.seed))
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES
  for (let n = 0; n < resamples; n++) {
    const sample = Array.from(
      { length: bins.length },
      () => bins[Math.floor(next() * bins.length)] as FitBin,
    )
    const b = solve(sample, k)
    if (b) b.forEach((v, i) => (draws[i] as number[]).push(v))
  }
  // Too few solvable draws say nothing about the spread.
  if ((draws[0] as number[]).length < resamples / 2) return { ...none, coef }
  const sorted = draws.map((d) => d.toSorted((p, q) => p - q))
  return {
    coef,
    low: sorted.map((d) => quantile(d, LOW_Q)),
    high: sorted.map((d) => quantile(d, HIGH_Q)),
  }
}

// ---------- reading the database ----------

export interface FitOptions {
  from: Date
  to: Date
  account?: string | null | undefined
  resamples?: number | undefined
}

interface BinRow {
  account: string
  win: Win
  bin: number
  pts: number
}
interface FamilyRow {
  account: string
  win: Win
  bin: number
  family: string
  weighted: number
}

/** Every observed stretch of a window: the ones that moved it, and the quiet ones (0026) that are observations with no points. */
const INTERVALS_CTE = `WITH iv AS (
  SELECT account, win, from_at, to_at, delta_pct FROM usage.window_intervals
  UNION ALL
  SELECT account, win, from_at, to_at, 0 FROM usage.window_quiet_intervals
)`

/**
 * One fit per account and window over the intervals that end in `[from, to)`. Intervals are summed into 3 h bins (the
 * meters move in whole points, a single interval is mostly zeros and ticks), quiet intervals included: a stretch with tokens and no
 * tick is an observation of zero points, and leaving it out would inflate every slope. A bin with no Max record in it carries no
 * information about any weight and is left out (the residual of `window` already counts it). Run inside the caller's
 * transaction when a report needs one snapshot.
 */
export async function fitWeights(sql: SQL, opts: FitOptions): Promise<WeightRow[]> {
  const from = opts.from.toISOString()
  const to = opts.to.toISOString()
  const account = opts.account ?? null
  const binRows = (await sql.unsafe(
    `${INTERVALS_CTE}
      SELECT i.account, i.win, floor(extract(epoch FROM i.to_at) / ${BIN_SECONDS})::bigint AS bin,
             sum(i.delta_pct)::float8 AS pts
      FROM iv i
      WHERE i.to_at >= $1::timestamptz AND i.to_at < $2::timestamptz
        AND ($3::text IS NULL OR i.account = $3::text)
      GROUP BY 1, 2, 3`,
    [from, to, account],
  )) as BinRow[]
  const familyRows = (await sql.unsafe(
    `${INTERVALS_CTE}
       SELECT i.account, i.win, floor(extract(epoch FROM i.to_at) / ${BIN_SECONDS})::bigint AS bin,
              ${FAMILY_SQL('r')} AS family, sum(${WEIGHTED_TOKENS_SQL('r')})::float8 AS weighted
       FROM iv i
       JOIN usage.records r
         ON r.billing = 'max' AND r.account = i.account AND r.ts > i.from_at AND r.ts <= i.to_at
       WHERE i.to_at >= $1::timestamptz AND i.to_at < $2::timestamptz
         AND ($3::text IS NULL OR i.account = $3::text)
       GROUP BY 1, 2, 3, 4`,
    [from, to, account],
  )) as FamilyRow[]

  const keyOf = (account: string, win: Win) => `${account}\u0000${win}`
  const groups = new Map<string, { account: string; win: Win; bins: Map<number, number> }>()
  for (const r of binRows) {
    const key = keyOf(r.account, r.win)
    const g = groups.get(key) ?? { account: r.account, win: r.win, bins: new Map() }
    g.bins.set(Number(r.bin), Number(r.pts))
    groups.set(key, g)
  }
  const weighted = new Map<string, Map<number, Map<string, number>>>()
  for (const r of familyRows) {
    const key = keyOf(r.account, r.win)
    const perBin = weighted.get(key) ?? new Map<number, Map<string, number>>()
    const perFamily = perBin.get(Number(r.bin)) ?? new Map<string, number>()
    perFamily.set(r.family, Number(r.weighted))
    perBin.set(Number(r.bin), perFamily)
    weighted.set(key, perBin)
  }

  const out: WeightRow[] = []
  for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const perBin = weighted.get(key) ?? new Map<number, Map<string, number>>()
    const totals = new Map<string, number>()
    for (const perFamily of perBin.values())
      for (const [family, w] of perFamily) totals.set(family, (totals.get(family) ?? 0) + w)
    const families = [...totals]
      .filter(([, w]) => w > 0)
      .sort(([af, aw], [bf, bw]) => bw - aw || af.localeCompare(bf))
      .map(([family]) => family)
    const bins: FitBin[] = []
    for (const [bin, y] of [...g.bins].sort(([a], [b]) => a - b)) {
      const perFamily = perBin.get(bin)
      if (!perFamily) continue
      const x = families.map((f) => perFamily.get(f) ?? 0)
      if (x.some((v) => v > 0)) bins.push({ y, x })
    }
    const fit = fitBins(bins, families.length, { seed: key, resamples: opts.resamples })
    const rows: WeightRow[] = families.map((family, i) => {
      const low = fit.low[i] ?? null
      const high = fit.high[i] ?? null
      return {
        account: g.account,
        win: g.win,
        family,
        weightedMtok: totals.get(family) as number,
        ptsPerMtok: fit.coef?.[i] ?? null,
        low,
        high,
        determined: low !== null && low > 0,
        relativeToReference: null,
        bins: bins.length,
      }
    })
    const ref = rows.find((r) => r.family === REFERENCE_FAMILY)
    for (const r of rows)
      if (ref?.determined && r.determined && ref.ptsPerMtok && r.ptsPerMtok !== null)
        r.relativeToReference = r.ptsPerMtok / ref.ptsPerMtok
    out.push(...rows)
  }
  return out
}

// ---------- rendering ----------

export const winLabel = (w: Win) => (w === 'five_hour' ? '5h' : '7d')
const num = (n: number | null, digits = 2) => (n === null ? '-' : n.toFixed(digits))
const mtok = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

/** A family's figure: the measured weight with its interval, or why there is none. */
export function weightText(r: WeightRow): string {
  return r.determined
    ? `${num(r.ptsPerMtok)} (${num(r.low)} to ${num(r.high)})`
    : `not determined yet (${mtok(r.weightedMtok)} weighted Mtok)`
}

/** Weight against the reference family: 1.00 for the reference itself, "-" while either side is undetermined. */
export const relativeText = (r: WeightRow): string =>
  r.family === REFERENCE_FAMILY && r.determined ? '1.00' : num(r.relativeToReference)

export function formatFit(rows: WeightRow[], opts: { days: number }): string {
  if (rows.length === 0)
    return '(no window movement with Max records in the period — run `ingest` first)'
  const lines: string[] = []
  const groups = new Map<string, WeightRow[]>()
  for (const r of rows) {
    const key = `${r.account}\u0000${r.win}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  for (const group of groups.values()) {
    const first = group[0] as WeightRow
    const famW = Math.max(6, ...group.map((r) => r.family.length))
    lines.push(
      `account ${first.account}, ${winLabel(first.win)} window, last ${opts.days} d (${first.bins} bins of 3 h)`,
      `${'family'.padEnd(famW)}  ${'pts/Mtok (90% interval)'.padEnd(26)}  ${'w.Mtok'.padStart(7)}  vs ${REFERENCE_FAMILY}`,
    )
    for (const r of group) {
      lines.push(
        r.determined
          ? `${r.family.padEnd(famW)}  ${weightText(r).padEnd(26)}  ${mtok(r.weightedMtok).padStart(7)}  ${relativeText(r)}`
          : `${r.family.padEnd(famW)}  ${weightText(r)}`,
      )
    }
    lines.push('')
  }
  lines.push(
    'pts/Mtok = points of the window per weighted million tokens (input + 5 x output + 1.25 x 5 m cache write + 2 x 1 h cache write + 0.1 x cache read);',
    'least squares through the origin on 3 h bins, 90% bootstrap interval, seeded. A window that followed list prices would show every family alike.',
    'Families that always run together cannot be told apart: their intervals are wide or undetermined.',
  )
  return lines.join('\n')
}
