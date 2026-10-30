import type { SQL } from 'bun'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildLatest } from '../../tools/iu-portal/latest.ts'
import type { PortalDocument } from '../../tools/iu-portal/parse.ts'
import { DEFAULT_IU_KEY, IU_KEYS, type IuKey, type IuKeyDef } from '../iu-keys.ts'
import { log } from '../log.ts'
import { normalizeModel } from '../models.ts'
import { loadCursor, saveState } from '../pg/state.ts'
import { iumacDisabled, iumacHost, SSH_OPTS } from '../remote.ts'

// IU's own cost report, the number that counts against the employee cap. No API
// carries it: the self-service portal is scraped from the MacBook (IU-managed
// Chrome holds the Entra session) by tools/iu-portal/scrape.ts over ssh, the API
// key piped through stdin so it never touches disk. Not a records source:
// rows go to usage.iu_portal_cost / usage.iu_portal_total. A MacBook that is asleep, a
// logged-out session or a broken scrape are all "skip and say why" — never a
// reason to fail the other collectors; `health` flags a stale source via
// `iuPortalFreshness`. Every successful ingest also writes latest.json here on the
// mini (the scrape wrote its twin on the MacBook): agent-gateway's OCR gate reads it.
//
// Every registered IU key (iu-keys.ts) has its own cap and its own report: the portal is
// asked once per key with that key typed into the form. Only the personal key's report
// feeds latest.json (OCR gate, Tinycast); the others pass `--no-latest` to the scrape.
// State is kept per key (`iu-portal` for the personal key, `iu-portal:<id>` otherwise).

export const PORTAL_SOURCE = 'iu-portal'
const REFRESH_MS = 4 * 3_600_000
const REMOTE_CMD = 'cd ~/.local/share/iu-portal/tool && bun scrape.ts daily monthly'
const HANG_GUARD_MS = 5 * 60_000
const KEY_TIMEOUT_MS = 30_000
const OTHER_FAILURE_BACKOFF_MS = 3_600_000
const UNREACHABLE = 255
const SESSION_EXPIRED = 3

export interface PortalFetch {
  code: number
  stdout: string
  stderr: string
}
export type PortalFetcher = (key: IuKeyDef) => Promise<PortalFetch>

interface PortalDoc {
  fetched_at?: string
  granularity: 'daily' | 'monthly'
  periods: string[]
  rows: Array<{ label: string; row: number; cells: Record<string, number> }>
}

export interface PortalState {
  lastOk: number | null
  lastAttempt: number | null
  lastCode: number | null
  /** Newest period of the last daily report: the portal's own "today". */
  lastDay: string | null
}

const EMPTY_STATE: PortalState = { lastOk: null, lastAttempt: null, lastCode: null, lastDay: null }

const stateSource = (iuKey: IuKey) =>
  iuKey === DEFAULT_IU_KEY ? PORTAL_SOURCE : `${PORTAL_SOURCE}:${iuKey}`

export async function readPortalState(
  sql: SQL,
  iuKey: IuKey = DEFAULT_IU_KEY,
): Promise<PortalState> {
  const raw = await loadCursor(sql, stateSource(iuKey))
  if (!raw) return EMPTY_STATE
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<PortalState>) }
  } catch {
    return EMPTY_STATE
  }
}

async function writePortalState(
  sql: SQL,
  iuKey: IuKey,
  state: PortalState,
  status: 'ok' | 'error',
  note: string,
): Promise<void> {
  await saveState(sql, stateSource(iuKey), { cursor: JSON.stringify(state), status, note })
}

/**
 * Freshness entries for `health` (one per IU key): the portal keeps no records rows. The newest sign of life is
 * the later of the last successful scrape (collector_state) and the newest cell/total the tables hold.
 */
export const iuPortalFreshnessAll = IU_KEYS.map((def) => ({
  source: stateSource(def.id),
  staleAfterHours: 48,
  // A secondary key counts once it has been tried: a key never attempted (not deployed yet) is not
  // stale, but one that keeps failing (secret missing, rejected) goes red like the personal one.
  available: async (sql?: SQL): Promise<boolean> =>
    !iumacDisabled() &&
    (def.id === DEFAULT_IU_KEY ||
      !sql ||
      (await readPortalState(sql, def.id)).lastAttempt !== null),
  newest: async (sql: SQL): Promise<string | null> => {
    const ok = (await readPortalState(sql, def.id)).lastOk
    const [row] = await sql`
      SELECT greatest(
        (SELECT max(fetched_at) FROM usage.iu_portal_cost WHERE iu_key = ${def.id}),
        (SELECT max(fetched_at) FROM usage.iu_portal_total WHERE iu_key = ${def.id})) AS fetched`
    const stored = row?.fetched ? new Date(row.fetched as string | Date).getTime() : null
    const newest = Math.max(ok ?? -Infinity, stored ?? -Infinity)
    return Number.isFinite(newest) ? new Date(newest).toISOString() : null
  },
}))

/** The personal key's entry: the one every IU consumer depends on. */
export const iuPortalFreshness = iuPortalFreshnessAll[0]!

/** The key's secret from the cache (the 1Password account is only a cache namespace), piped into the scrape on iumac. */
export const sshFetcher: PortalFetcher = async (def) => {
  const keyProc = Bun.spawn(['secrets-run', 'read', def.secretRef], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, OP_ACCOUNT: def.account },
    timeout: KEY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const key = (await new Response(keyProc.stdout).text()).trim()
  if ((await keyProc.exited) !== 0 || !key)
    return { code: 1, stdout: '', stderr: `API key ${def.id} unresolvable via secrets-run` }

  // Only the personal report may become latest.json (Tinycast, the OCR gate).
  const remote = def.id === DEFAULT_IU_KEY ? REMOTE_CMD : `${REMOTE_CMD} --no-latest`
  const proc = Bun.spawn(['ssh', ...SSH_OPTS, iumacHost(), remote], {
    stdin: Buffer.from(key),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: HANG_GUARD_MS,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** `IU_PORTAL_ROOT` mirrors scrape.ts, so tests and the MacBook share one override. */
function latestPath(): string {
  return join(
    process.env.IU_PORTAL_ROOT ?? join(homedir(), '.local/share/iu-portal'),
    'latest.json',
  )
}

/** Same schema-1 document the scrape writes on iumac; atomic so a reader never sees half of it. */
function writeLatest(doc: PortalDoc, now: number): void {
  const path = latestPath()
  const full: PortalDocument = {
    fetched_at: new Date(now).toISOString(),
    cost_center: null,
    total_usd: 0,
    ...doc,
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(buildLatest(full), null, 2)}\n`)
  renameSync(tmp, path)
}

function parseDocs(stdout: string): PortalDoc[] {
  const docs: PortalDoc[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    const d = JSON.parse(line) as Partial<PortalDoc>
    if (
      (d.granularity !== 'daily' && d.granularity !== 'monthly') ||
      !Array.isArray(d.periods) ||
      !Array.isArray(d.rows)
    ) {
      throw new Error('malformed scrape document')
    }
    docs.push(d as PortalDoc)
  }
  return docs
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Map each portal label onto our model by comparing alphanumerics of the
 * label with those of every IU-billed raw model id and its normalization
 * (`Claude Haiku 5 5 Eu` = `claude-haiku-5-5-eu` → `claude-haiku-5-5`). Unmatched
 * labels stay NULL, which is the "spend we cannot see" signal.
 */
export async function resolvePortalModels(sql: SQL): Promise<void> {
  const known = new Map<string, string>()
  const rows =
    await sql`SELECT DISTINCT model_raw, model FROM usage.records WHERE billing = 'api_key' AND model IS NOT NULL`
  for (const r of rows) {
    const norm = String(r.model)
    known.set(alnum(norm), norm)
    if (r.model_raw) known.set(alnum(String(r.model_raw)), norm)
    const viaRaw = r.model_raw ? normalizeModel(String(r.model_raw)) : null
    if (viaRaw) known.set(alnum(viaRaw), norm)
  }
  const labels = await sql`SELECT DISTINCT label FROM usage.iu_portal_cost`
  const mapping = labels.map((l: Record<string, unknown>) => ({
    label: String(l.label),
    model: known.get(alnum(String(l.label))) ?? null,
  }))
  if (mapping.length === 0) return
  await sql`
    UPDATE usage.iu_portal_cost c SET model = j.model
    FROM jsonb_to_recordset(${JSON.stringify(mapping)}::text::jsonb) AS j(label text, model text)
    WHERE c.label = j.label AND c.model IS DISTINCT FROM j.model`
}

async function storeDaily(
  sql: SQL,
  iuKey: IuKey,
  doc: PortalDoc,
  fetchedAt: number,
): Promise<number> {
  const first = doc.periods[0]
  const last = doc.periods.at(-1)
  if (!first || !last) return 0
  const cells: Array<{ day: string; label: string; row: number; cost_usd: number }> = []
  for (const row of doc.rows) {
    for (const [day, usd] of Object.entries(row.cells))
      cells.push({ day, label: row.label, row: row.row, cost_usd: usd })
  }
  await sql.begin(async (tx) => {
    // The report is the whole truth for its window: a cell that went away is gone.
    await tx`DELETE FROM usage.iu_portal_cost WHERE iu_key = ${iuKey} AND day >= ${first}::date AND day <= ${last}::date`
    if (cells.length === 0) return
    await tx`
      INSERT INTO usage.iu_portal_cost (iu_key, day, label, "row", cost_usd, fetched_at)
      SELECT ${iuKey}, day, label, "row", cost_usd, ${new Date(fetchedAt).toISOString()}::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify(cells)}::text::jsonb) AS j(day date, label text, "row" integer, cost_usd numeric)
      ON CONFLICT (iu_key, day, label, "row") DO UPDATE SET cost_usd = EXCLUDED.cost_usd, fetched_at = EXCLUDED.fetched_at`
  })
  return cells.length
}

/** Monthly totals, minus the first period: a "3 Months" window starts mid-month. */
async function storeMonthly(
  sql: SQL,
  iuKey: IuKey,
  doc: PortalDoc,
  fetchedAt: number,
): Promise<void> {
  const totals = doc.periods.slice(1).map((month) => ({
    month,
    total_usd: Math.round(doc.rows.reduce((sum, r) => sum + (r.cells[month] ?? 0), 0) * 100) / 100,
  }))
  if (totals.length === 0) return
  await sql`
    INSERT INTO usage.iu_portal_total (iu_key, month, total_usd, fetched_at)
    SELECT ${iuKey}, month, total_usd, ${new Date(fetchedAt).toISOString()}::timestamptz
    FROM jsonb_to_recordset(${JSON.stringify(totals)}::text::jsonb) AS j(month text, total_usd numeric)
    ON CONFLICT (iu_key, month) DO UPDATE SET total_usd = EXCLUDED.total_usd, fetched_at = EXCLUDED.fetched_at`
}

export interface CollectPortalOptions {
  fetch?: PortalFetcher
  now?: number
  /** Ignore the 4 h throttle. */
  force?: boolean
  /** Keys to fetch; every registered key by default. */
  keys?: readonly IuKeyDef[]
}

interface KeyOutcome {
  cells: number
  /** The scrape's exit code, null when the key was throttled or the host is disabled. */
  code: number | null
}

/**
 * Fetch and store each key's portal report, at most once per 4 h per key. Returns the
 * number of daily cells written (0 when throttled, unreachable or failed). Never throws.
 * A signed-out session or an unreachable MacBook is the same for every key, so it ends the pass.
 */
export async function collectPortal(sql: SQL, opts: CollectPortalOptions = {}): Promise<number> {
  let cells = 0
  for (const def of opts.keys ?? IU_KEYS) {
    const out = await collectPortalKey(sql, def, opts)
    cells += out.cells
    if (out.code === SESSION_EXPIRED || out.code === UNREACHABLE) break
  }
  return cells
}

async function collectPortalKey(
  sql: SQL,
  def: IuKeyDef,
  opts: CollectPortalOptions,
): Promise<KeyOutcome> {
  const now = opts.now ?? Date.now()
  const state = await readPortalState(sql, def.id)
  const sinceOk = state.lastOk === null ? Infinity : now - state.lastOk
  const sinceAttempt = state.lastAttempt === null ? Infinity : now - state.lastAttempt
  // An expired session needs a human, and a scrape that keeps failing launches a browser each
  // time: back both off. Only an unreachable MacBook is retried every run (it costs one ssh).
  const failBackoff =
    state.lastCode === SESSION_EXPIRED
      ? REFRESH_MS
      : state.lastCode === UNREACHABLE || !state.lastCode
        ? 0
        : OTHER_FAILURE_BACKOFF_MS
  const backoff = sinceAttempt < failBackoff
  if (!opts.force && (sinceOk < REFRESH_MS || backoff)) return { cells: 0, code: null }
  if (iumacDisabled()) return { cells: 0, code: null }

  const fail = async (reason: string, code: number): Promise<KeyOutcome> => {
    log.warn(`iu-portal[${def.id}]: ${reason}`)
    await writePortalState(
      sql,
      def.id,
      { ...state, lastAttempt: now, lastCode: code },
      'error',
      reason,
    )
    return { cells: 0, code }
  }

  try {
    const res = await (opts.fetch ?? sshFetcher)(def)
    if (res.code === SESSION_EXPIRED)
      return await fail('session expired — run make iu-portal-login', res.code)
    if (res.code === UNREACHABLE)
      return await fail('iumac unreachable (MacBook asleep or offline)', res.code)
    if (res.code !== 0)
      return await fail(
        `scrape exited ${res.code}: ${res.stderr.trim().split('\n').at(-1) ?? ''}`,
        res.code,
      )

    const docs = parseDocs(res.stdout)
    const daily = docs.find((d) => d.granularity === 'daily')
    if (!daily) return await fail('scrape returned no daily report', res.code)
    const written = await storeDaily(sql, def.id, daily, now)
    for (const d of docs) if (d.granularity === 'monthly') await storeMonthly(sql, def.id, d, now)
    await resolvePortalModels(sql)
    await writePortalState(
      sql,
      def.id,
      { lastOk: now, lastAttempt: now, lastCode: 0, lastDay: daily.periods.at(-1) ?? null },
      'ok',
      `${written} cells`,
    )
    if (def.id === DEFAULT_IU_KEY) {
      try {
        writeLatest(daily, now)
      } catch (err) {
        log.warn(
          `iu-portal: latest.json not written: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { cells: written, code: 0 }
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err), 1)
  }
}
