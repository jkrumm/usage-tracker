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

async function fetchChunk(
  window: { from: Date; to: Date },
  opts: { baseUrl: string; adminKey: string; fetch: typeof fetch },
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      // The request carries the key in a header; report the failure kind only.
      throw new AdminApiError(`request failed (${err instanceof Error ? err.name : 'error'})`)
    }
    if (!res.ok) throw new AdminApiError(`HTTP ${res.status}`)
    const body = (await res.json().catch(() => null)) as CostResponse | null
    if (!body || !Array.isArray(body.data)) throw new AdminApiError('unexpected response shape')

    // Every page reads one snapshot: the first page's stamp stands for the chunk.
    if (!refreshedAt) {
      const stamp =
        typeof body.data_refreshed_at === 'string' ? new Date(body.data_refreshed_at) : null
      if (!stamp || Number.isNaN(stamp.getTime()))
        throw new AdminApiError('data_refreshed_at missing')
      refreshedAt = stamp
    }

    for (const raw of body.data as Array<Record<string, any>>) {
      const startingAt = raw?.starting_at
      const amount = raw?.cost?.amount
      if (typeof startingAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(startingAt)) {
        throw new AdminApiError('row without starting_at')
      }
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new AdminApiError('row without cost.amount')
      }
      const day = startingAt.slice(0, 10)
      const model = typeof raw.group?.model === 'string' ? raw.group.model : null
      const apiKeyId = typeof raw.group?.api_key_id === 'string' ? raw.group.api_key_id : null
      const key = JSON.stringify([day, model, apiKeyId])
      const hit = rows.get(key)
      const cents = toScaled(String(amount))
      if (hit) hit.sum += cents
      else rows.set(key, { row: { day, model, apiKeyId }, sum: cents })
    }

    if (body.has_more !== true) return { rows, refreshedAt }
    if (typeof body.next_page !== 'string' || !body.next_page) {
      throw new AdminApiError('has_more without next_page')
    }
    page = body.next_page
  }
  throw new AdminApiError('too many pages')
}

/**
 * Read the cost rows of one org over `windows`, all or nothing: a failed request throws and the caller writes nothing,
 * so a half-read window never reaches the table. Rows are summed per (day, model, key) in exact decimal arithmetic.
 */
export async function fetchCost(
  windows: Array<{ from: Date; to: Date }>,
  opts: { baseUrl?: string; adminKey: string; fetch?: typeof fetch },
): Promise<CostFetch> {
  const rows = new Map<string, CostRow>()
  const chunks: Chunk[] = []
  for (const w of windows) {
    const got = await fetchChunk(w, {
      baseUrl: opts.baseUrl ?? ADMIN_API_BASE,
      adminKey: opts.adminKey,
      fetch: opts.fetch ?? fetch,
    })
    chunks.push({ from: w.from, to: w.to, refreshedAt: got.refreshedAt })
    for (const [key, { row, sum }] of got.rows)
      rows.set(key, { ...row, cents: fromScaled(sum), refreshedAt: got.refreshedAt })
  }
  return { rows: [...rows.values()], chunks }
}
