import { utcDay } from './cycle.ts'

// Anthropic Admin API, cost by day: `GET /v1/organizations/analytics/cost` (beta). Request shapes and units come from
// agent-workflows docs/spikes/gateway/admin-api.md (probed live): `amount` is CENTS as a decimal string, at list price,
// before credits; rows with no usage are absent; `model` and `api_key_id` can be null. Pure HTTP: no Postgres, no
// secrets resolution. The admin key goes in the `x-api-key` header and nowhere else: not in a log, not in an error.

export const ADMIN_API_BASE = 'https://api.anthropic.com'
const BETA = 'analytics-usage-cost-2026-08-24'
const FLOOR = Date.UTC(2026, 0, 1) // the API refuses starting_at before 2026-01-01
const DAY_MS = 86_400_000
const MAX_REQUEST_DAYS = 31
const DEFAULT_TRAILING_DAYS = 35
const REQUEST_TIMEOUT_MS = 30_000
/** All requests of one org together: a slow Admin API must not stall the 900 s ingest. */
export const ORG_DEADLINE_MS = 120_000
const MAX_PAGES = 50
const SCALE = 12 // decimals kept when summing amounts; the API sends 6

export interface CostRow {
  /** UTC day, YYYY-MM-DD. */
  day: string
  model: string | null
  apiKeyId: string | null
  /** Cents, decimal string, exactly as the sum of the API's amounts (no float). */
  cents: string
  /** The snapshot (`data_refreshed_at`) of the request this row came from. */
  refreshedAt: Date
}

/** One request window and the snapshot the provider answered it from. */
export interface Chunk {
  from: Date
  to: Date
  refreshedAt: Date
}

export interface CostFetch {
  rows: CostRow[]
  chunks: Chunk[]
}

/** Why a request failed, never carrying the key or the response body. */
export class AdminApiError extends Error {}

/**
 * The trailing window to re-query: from the earlier of the previous cycle's start and `trailingDays` back (never before
 * 2026-01-01) to the end of today, split into requests of at most 31 days. Values are revised for days, so we re-read.
 */
export function adminWindows(
  previousCycleStart: Date | null,
  now: Date,
  trailingDays = DEFAULT_TRAILING_DAYS,
): Array<{ from: Date; to: Date }> {
  const today = utcDay(now).getTime()
  let from = today - trailingDays * DAY_MS
  if (previousCycleStart) from = Math.min(from, previousCycleStart.getTime())
  from = Math.max(from, FLOOR)
  const end = today + DAY_MS
  const windows: Array<{ from: Date; to: Date }> = []
  for (let s = from; s < end; s += MAX_REQUEST_DAYS * DAY_MS) {
    windows.push({ from: new Date(s), to: new Date(Math.min(s + MAX_REQUEST_DAYS * DAY_MS, end)) })
  }
  return windows
}

/** Decimal string -> integer scaled by 10^SCALE. */
function toScaled(amount: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount)
  if (!m) throw new AdminApiError('cost.amount is not a decimal string')
  const frac = (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE)
  const n = BigInt(m[2]! + frac)
  return m[1] ? -n : n
}

function fromScaled(n: bigint): string {
  const neg = n < 0n
  const digits = (neg ? -n : n).toString().padStart(SCALE + 1, '0')
  const whole = digits.slice(0, -SCALE)
  const frac = digits.slice(-SCALE).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

interface CostResponse {
  data?: unknown
  has_more?: unknown
  next_page?: unknown
  data_refreshed_at?: unknown
}

/** A JSON number as a fixed-point decimal string (String() would give 1e-7); null when it is not finite. */
function numberToDecimal(n: number): string | null {
  return Number.isFinite(n) ? n.toFixed(SCALE) : null
}

interface ParsedRow {
  day: string
  model: string | null
  apiKeyId: string | null
  amount: bigint
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** One `data` entry, or an AdminApiError: a response that does not look like the spike's is malformed, never guessed at. */
function parseRow(raw: unknown): ParsedRow {
  if (!isObject(raw) || !isObject(raw.cost)) throw new AdminApiError('malformed row')
  const startingAt = raw.starting_at
  if (typeof startingAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(startingAt)) {
    throw new AdminApiError('row without starting_at')
  }
  const amount =
    typeof raw.cost.amount === 'number' ? numberToDecimal(raw.cost.amount) : raw.cost.amount
  if (typeof amount !== 'string') throw new AdminApiError('row without a usable cost.amount')
  const group = raw.group ?? {}
  if (!isObject(group)) throw new AdminApiError('malformed row group')
  const field = (v: unknown): string | null => {
    if (v == null) return null
    if (typeof v === 'string') return v
    throw new AdminApiError('malformed row group')
  }
  return {
    day: startingAt.slice(0, 10),
    model: field(group.model),
    apiKeyId: field(group.api_key_id),
    amount: toScaled(amount),
  }
}

async function fetchChunk(
  window: { from: Date; to: Date },
  opts: { baseUrl: string; adminKey: string; fetch: typeof fetch; deadline: AbortSignal },
): Promise<{
  rows: Map<string, { row: Omit<CostRow, 'cents' | 'refreshedAt'>; sum: bigint }>
  refreshedAt: Date
}> {
  const rows = new Map<string, { row: Omit<CostRow, 'cents' | 'refreshedAt'>; sum: bigint }>()
  let refreshedAt: Date | null = null
  let page: string | null = null
  for (let n = 0; n < MAX_PAGES; n++) {
    const url = new URL('/v1/organizations/analytics/cost', opts.baseUrl)
    url.searchParams.set('starting_at', window.from.toISOString())
    url.searchParams.set('ending_at', window.to.toISOString())
    url.searchParams.set('time_bucket_width', '1d')
    url.searchParams.append('group_by[]', 'api_key_id')
    url.searchParams.append('group_by[]', 'model')
    url.searchParams.set('limit', '1000')
    if (page) url.searchParams.set('page', page)

    let res: Response
    try {
      res = await opts.fetch(url, {
        headers: {
          'x-api-key': opts.adminKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': BETA,
          'user-agent': 'usage-tracker (credit pass)',
        },
        // The key is in a header: a redirect would carry it to another host.
        redirect: 'error',
        signal: AbortSignal.any([opts.deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
    } catch (err) {
      // The request carries the key in a header; report the failure kind only.
      if (opts.deadline.aborted) throw new AdminApiError('deadline exceeded')
      throw new AdminApiError(`request failed (${err instanceof Error ? err.name : 'error'})`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined) // release the connection; the body is never read or logged
      throw new AdminApiError(`HTTP ${res.status}`)
    }
    const body = (await res.json().catch(() => null)) as CostResponse | null
    if (opts.deadline.aborted) throw new AdminApiError('deadline exceeded')
    if (!isObject(body) || !Array.isArray(body.data)) {
      throw new AdminApiError('unexpected response shape')
    }
    // A truncated or foreign body must never read as "no more rows": it would delete rows and close a cycle at zero.
    if (typeof body.has_more !== 'boolean') throw new AdminApiError('has_more is not a boolean')

    // Every page reads one snapshot: the first page's stamp stands for the chunk.
    if (!refreshedAt) {
      const stamp =
        typeof body.data_refreshed_at === 'string' ? new Date(body.data_refreshed_at) : null
      if (!stamp || Number.isNaN(stamp.getTime()))
        throw new AdminApiError('data_refreshed_at missing')
      refreshedAt = stamp
    }

    for (const raw of body.data) {
      const { day, model, apiKeyId, amount } = parseRow(raw)
      const key = JSON.stringify([day, model, apiKeyId])
      const hit = rows.get(key)
      if (hit) hit.sum += amount
      else rows.set(key, { row: { day, model, apiKeyId }, sum: amount })
    }

    if (!body.has_more) return { rows, refreshedAt }
    if (typeof body.next_page !== 'string' || !body.next_page) {
      throw new AdminApiError('has_more without next_page')
    }
    page = body.next_page
  }
  throw new AdminApiError('too many pages')
}

/**
 * Read the cost rows of one org over `windows` within one overall deadline, all or nothing: a failed request throws and the caller writes nothing,
 * so a half-read window never reaches the table. Rows are summed per (day, model, key) in exact decimal arithmetic.
 */
export async function fetchCost(
  windows: Array<{ from: Date; to: Date }>,
  opts: { baseUrl?: string; adminKey: string; fetch?: typeof fetch; deadlineMs?: number },
): Promise<CostFetch> {
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? ORG_DEADLINE_MS)
  const rows = new Map<string, CostRow>()
  const chunks: Chunk[] = []
  for (const w of windows) {
    const got = await fetchChunk(w, {
      baseUrl: opts.baseUrl ?? ADMIN_API_BASE,
      adminKey: opts.adminKey,
      fetch: opts.fetch ?? fetch,
      deadline,
    })
    chunks.push({ from: w.from, to: w.to, refreshedAt: got.refreshedAt })
    for (const [key, { row, sum }] of got.rows)
      rows.set(key, { ...row, cents: fromScaled(sum), refreshedAt: got.refreshedAt })
  }
  return { rows: [...rows.values()], chunks }
}
