import type { SQL } from 'bun'
import { getSessionBaseUrl } from './models.ts'

// Read-side queries for the CLI, over the Postgres usage schema. All output is plain aligned text (stdout) so it
// pipes cleanly; no box-drawing.

export type GroupBy =
  | 'source'
  | 'model'
  | 'billing'
  | 'day'
  | 'machine'
  | 'lane'
  | 'account'
  | 'iu_key'
  | 'repo'
  | 'role'
  | 'subagent_type'
  | 'effort'

interface StatRow {
  key: string
  records: number
  input: number
  output: number
  cacheWrite: number
  reasoning: number
  costUsd: number | null
}

/** Whitelisted: the only strings ever spliced into the query. `iu_key` is the IU key id, stored in `api_key`. */
const GROUP_EXPR: Record<GroupBy, string> = {
  source: 'source',
  model: "coalesce(model, '(unknown)')",
  billing: 'billing',
  day: "to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
  machine: "coalesce(machine, '(unknown)')",
  lane: "coalesce(lane, '(none)')",
  account: "coalesce(account, '(n/a)')",
  iu_key: "coalesce(api_key, '(n/a)')",
  repo: "coalesce(repo, '(none)')",
  // lane_detail.role is the factory role of the session (or of the tree a subagent belongs to), lane_detail.subagent_type
  // the agent type of a subagent record; effort is the request's reasoning effort.
  role: "coalesce(lane_detail->>'role', '(none)')",
  subagent_type: "coalesce(lane_detail->>'subagent_type', '(none)')",
  effort: "coalesce(effort, '(none)')",
}

export const GROUP_BY_DIMS = Object.keys(GROUP_EXPR) as GroupBy[]

// Reads usage.records_unique: the gateway mirror copies (docs/usage-schema.md, Duplicates) are not counted twice.
export async function stats(
  sql: SQL,
  opts: { by: GroupBy; sinceDays?: number },
): Promise<StatRow[]> {
  const expr = GROUP_EXPR[opts.by]
  if (!expr) throw new Error(`--by must be one of: ${GROUP_BY_DIMS.join(', ')}`)
  // Error rows carry no tokens and would only dilute counts — keep token/cost
  // aggregates to successful requests; the error rate lives in `sources`.
  //
  // cache_read_tokens is deliberately NOT summed here: Anthropic reports it as
  // the full accumulated prior context re-read from cache on *every* turn, not
  // a delta, so summing it across many rows re-counts the same underlying
  // tokens repeatedly and inflates the total. Cache writes (cache creation) are
  // genuinely incremental per turn, so they are safe to sum. cost_usd is
  // unaffected — it's computed per-row with cache_read's own cheap rate
  // before being summed, so dollar totals stay correct.
  const since = opts.sinceDays ? Math.floor(opts.sinceDays) : null
  const rows = await sql.unsafe(
    `SELECT ${expr} AS key,
            count(*)::int                                        AS records,
            coalesce(sum(input_tokens), 0)::float8               AS input,
            coalesce(sum(output_tokens), 0)::float8              AS output,
            coalesce(sum(cache_write_5m_tokens + cache_write_1h_tokens), 0)::float8 AS "cacheWrite",
            coalesce(sum(reasoning_tokens), 0)::float8           AS reasoning,
            sum(cost_usd)::float8                                AS "costUsd"
     FROM usage.records_unique
     WHERE outcome = 'ok' AND ($1::int IS NULL OR ts >= now() - make_interval(days => $1::int))
     GROUP BY 1
     ORDER BY "costUsd" DESC NULLS LAST, records DESC`,
    [since],
  )
  return rows as StatRow[]
}

export interface UnpricedModel {
  model: string
  rows: number
}

/**
 * Rows no price covers (cost_source = 'none') — a new/unrecognized model id
 * is NULL-cost otherwise, which looks identical to a genuinely free local
 * model. Grouped by model so the ingest summary can name the culprit instead
 * of just a count.
 */
export async function unpricedByModel(sql: SQL): Promise<UnpricedModel[]> {
  const rows = await sql`
    SELECT coalesce(model, '(unknown)') AS model, count(*)::int AS rows
    FROM usage.records
    WHERE cost_source = 'none'
    GROUP BY 1
    ORDER BY 2 DESC`
  return rows.map((r: Record<string, unknown>) => ({
    model: String(r.model),
    rows: Number(r.rows),
  }))
}

export interface SourceStatus {
  source: string
  records: number
  lastRunAt: string | null
  lastStatus: string | null
  lastNote: string | null
  errors: number
  total: number
}

export async function sourceStatus(sql: SQL): Promise<SourceStatus[]> {
  // errors/total come from the rows themselves (LEFT JOIN), so sources that
  // never log failures simply show 0 — only the bridge surfaces a real rate.
  const rows = await sql`
    SELECT cs.source                               AS source,
           cs.records_total::float8                AS records,
           to_char(cs.last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS "lastRunAt",
           cs.last_status                          AS "lastStatus",
           cs.last_note                            AS "lastNote",
           coalesce(oc.errors, 0)::int             AS errors,
           coalesce(oc.total, 0)::int              AS total
    FROM usage.collector_state cs
    LEFT JOIN (
      SELECT source,
             count(*) FILTER (WHERE outcome = 'error') AS errors,
             count(*)                                  AS total
      FROM usage.records
      GROUP BY source
    ) oc ON oc.source = cs.source
    ORDER BY cs.source`
  return rows as unknown as SourceStatus[]
}

export interface BillingAuditRow {
  sessionId: string
  records: number
  models: string
  billings: string
  /** Distinct accounts on the session's Max rows ("" when none, e.g. an IU session). */
  accounts: string
  costUsd: number | null
  firstTs: string
  lastTs: string
  liveLabel: 'expired/missing' | 'max (c)' | 'iu (ca)'
  multiBilling: boolean
  mismatch: boolean
}

/**
 * Per-session view over claude-code rows, cross-referenced against the live
 * hook log (`getSessionBaseUrl`) rather than trusting the stored `billing`
 * column alone — that's the whole point of the audit. A session showing more
 * than one distinct `billing` value is a bug post-fix (every row in a session,
 * subagents included, must bill the same way); `mismatch` is only set when the
 * live log can still answer (inside its 3-day retention). A non-empty live
 * base_url means `api_key` billing, an empty one `max`.
 */
export async function sessionBillingAudit(
  sql: SQL,
  opts: { sinceDays?: number; sessionId?: string } = {},
): Promise<BillingAuditRow[]> {
  const since = opts.sinceDays ? Math.floor(opts.sinceDays) : null
  const rows = await sql`
    SELECT s.source_session_id                                   AS "sessionId",
           count(*)::int                                         AS records,
           coalesce(string_agg(DISTINCT r.model, ','), '')       AS models,
           coalesce(string_agg(DISTINCT r.billing, ','), '')     AS billings,
           coalesce(string_agg(DISTINCT r.account, ','), '')     AS accounts,
           sum(r.cost_usd)::float8                               AS "costUsd",
           to_char(min(r.ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "firstTs",
           to_char(max(r.ts) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastTs"
    FROM usage.records r
    JOIN usage.sessions s ON s.id = r.session_id
    WHERE r.source = 'claude-code'
      AND (${since}::int IS NULL OR r.ts >= now() - make_interval(days => ${since}::int))
      AND (${opts.sessionId ?? null}::text IS NULL OR s.source_session_id = ${opts.sessionId ?? null}::text)
    GROUP BY 1
    ORDER BY max(r.ts) DESC`

  return rows.map((row: Record<string, unknown>) => {
    const sessionId = String(row.sessionId)
    const liveBaseUrl = getSessionBaseUrl(sessionId)
    const liveLabel: BillingAuditRow['liveLabel'] =
      liveBaseUrl === undefined ? 'expired/missing' : liveBaseUrl ? 'iu (ca)' : 'max (c)'
    const billingValues = String(row.billings).split(',').filter(Boolean)
    const expected = liveBaseUrl === undefined ? null : liveBaseUrl ? 'api_key' : 'max'
    return {
      sessionId,
      records: Number(row.records),
      models: String(row.models),
      billings: String(row.billings),
      accounts: String(row.accounts),
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
      firstTs: String(row.firstTs),
      lastTs: String(row.lastTs),
      liveLabel,
      multiBilling: billingValues.length > 1,
      mismatch: expected != null && !(billingValues.length === 1 && billingValues[0] === expected),
    }
  })
}

// ── formatting ──────────────────────────────────────────────────────────────

export function formatStats(rows: StatRow[], by: GroupBy): string {
  if (rows.length === 0) return '(no data — run `ingest` first)'

  const header = [
    pad(by, 22),
    r('records', 9),
    r('input', 13),
    r('output', 12),
    r('cacheW', 12),
    r('cost $', 11),
  ]
  const lines = [header.join('  ')]
  lines.push('-'.repeat(header.join('  ').length))

  let tCost = 0
  for (const row of rows) {
    tCost += row.costUsd ?? 0
    lines.push(
      [
        pad(row.key, 22),
        r(num(row.records), 9),
        r(num(row.input), 13),
        r(num(row.output), 12),
        r(num(row.cacheWrite), 12),
        r(row.costUsd == null ? 'n/a' : usd(row.costUsd), 11),
      ].join('  '),
    )
  }
  lines.push('-'.repeat(header.join('  ').length))
  lines.push(
    [pad('TOTAL', 22), r('', 9), r('', 13), r('', 12), r('', 12), r(usd(tCost), 11)].join('  '),
  )
  return lines.join('\n')
}

export function formatSources(rows: SourceStatus[]): string {
  if (rows.length === 0) return '(no collector state yet — run `ingest`)'
  const lines = [
    [
      pad('source', 14),
      r('records', 9),
      pad('status', 9),
      r('err%', 7),
      pad('last run (UTC)', 22),
      'note',
    ].join('  '),
  ]
  for (const s of rows) {
    lines.push(
      [
        pad(s.source, 14),
        r(num(s.records), 9),
        pad(s.lastStatus ?? '-', 9),
        r(errPct(s), 7),
        pad(s.lastRunAt ?? '-', 22),
        s.lastNote ?? '',
      ].join('  '),
    )
  }
  return lines.join('\n')
}

export function formatBillingAudit(rows: BillingAuditRow[]): string {
  if (rows.length === 0) return '(no claude-code sessions in range)'

  const header = [
    pad('session', 36),
    r('rows', 5),
    pad('models', 24),
    pad('billing', 14),
    pad('live', 15),
    pad('last (UTC)', 20),
    pad('acct', 8),
    'flags',
  ]
  const lines = [header.join('  ')]
  lines.push('-'.repeat(header.join('  ').length))

  let flagged = 0
  for (const row of rows) {
    const flags = [row.multiBilling && 'MULTI-BILLING', row.mismatch && 'MISMATCH']
      .filter(Boolean)
      .join(' ')
    if (flags) flagged++
    lines.push(
      [
        pad(row.sessionId, 36),
        r(num(row.records), 5),
        pad(row.models, 24),
        pad(row.billings, 14),
        pad(row.liveLabel, 15),
        pad(row.lastTs, 20),
        pad(row.accounts || '-', 8),
        flags,
      ].join('  '),
    )
  }
  lines.push('-'.repeat(header.join('  ').length))
  lines.push(`${rows.length} session${rows.length === 1 ? '' : 's'}, ${flagged} flagged`)
  return lines.join('\n')
}

// "-" when nothing seen yet, "0%" when clean, else one decimal (e.g. "4.2%").
const errPct = (s: SourceStatus): string => {
  if (s.total === 0) return '-'
  if (s.errors === 0) return '0%'
  return `${((s.errors / s.total) * 100).toFixed(1)}%`
}

const num = (n: number | null) => (n ?? 0).toLocaleString('en-US')
const usd = (n: number) => `$${n.toFixed(n < 10 ? 4 : 2)}`
const pad = (s: string, w: number) => s.padEnd(w).slice(0, Math.max(w, s.length))
const r = (s: string, w: number) => s.padStart(w)

export interface StaleSource {
  source: string
  /** Newest row's `ts`, or null when the source has never produced a row. */
  newestTs: string | null
  ageHours: number | null
  limitHours: number
}

/**
 * Sources whose newest row is older than their declared cadence. Judged on the
 * rows themselves (`max(ts)` in usage.records), not on collector_state: a
 * collector pointed at a moved store still reports `ok` with zero records,
 * which is exactly how the agent-gateway OpenCode spend went missing. Only
 * collectors present on this machine count.
 */
export async function staleSources(
  sql: SQL,
  collectors: ReadonlyArray<{
    source: string
    staleAfterHours?: number | null
    available(sql?: SQL): boolean | Promise<boolean>
    /** Freshness for sources that keep no records rows (default: newest usage.records.ts). */
    newest?(sql: SQL): Promise<string | null>
  }>,
  now = new Date(),
): Promise<StaleSource[]> {
  const watched = collectors.filter((c) => c.staleAfterHours != null)
  if (watched.length === 0) return []
  // One grouped read for every source instead of a max(ts) scan per source.
  const rows = await sql`SELECT source, max(ts) AS ts FROM usage.records GROUP BY source`
  const newestBySource = new Map<string, string>(
    rows.map((r: Record<string, unknown>) => [
      String(r.source),
      new Date(r.ts as string | Date).toISOString(),
    ]),
  )

  const stale: StaleSource[] = []
  for (const c of watched) {
    const limit = c.staleAfterHours as number
    const newestTs = (c.newest ? await c.newest(sql) : null) ?? newestBySource.get(c.source) ?? null
    // A source that has produced rows but whose store vanished is the moved-store
    // failure itself; only a source never seen on this machine is exempt.
    if (!(await c.available(sql)) && newestTs === null) continue
    const ageHours = newestTs ? (now.getTime() - Date.parse(newestTs)) / 3_600_000 : null
    // A non-finite or future-dated newest row (beyond clock skew) can't prove
    // freshness, so it counts as stale rather than passing every comparison.
    const fresh = ageHours !== null && ageHours >= -FUTURE_SKEW_HOURS && ageHours <= limit
    if (!fresh) stale.push({ source: c.source, newestTs, ageHours, limitHours: limit })
  }
  return stale
}

const FUTURE_SKEW_HOURS = 1

export function formatStale(stale: StaleSource[]): string {
  return stale
    .map((s) =>
      s.ageHours === null || !Number.isFinite(s.ageHours)
        ? `stale: ${s.source} has no rows (limit ${s.limitHours}h)`
        : `stale: ${s.source} newest row ${s.newestTs} is ${s.ageHours.toFixed(1)}h old (limit ${s.limitHours}h)`,
    )
    .join('\n')
}
