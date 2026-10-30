import type { SQL } from 'bun'
import type { SessionEnvRow } from './session-env.ts'
import { parseAccount } from '../models.ts'

// usage.collector_state (cursor + last-run bookkeeping per collector, plus the state-only keys `account-picks` and
// `iu-portal[:<key>]`) and the full read of usage.session_env that primes the hook-log lookups at the start of a run.

export async function loadCursor(sql: SQL, source: string): Promise<string | null> {
  const [row] = await sql`SELECT cursor FROM usage.collector_state WHERE source = ${source}`
  return row?.cursor ?? null
}

export interface StateUpdate {
  /** New watermark; `undefined` keeps the stored one (an errored run must not lose its cursor). */
  cursor?: string | null
  status: 'ok' | 'skipped' | 'error'
  note?: string | null
}

/** Record a run: cursor, last_run_at, status, note and the number of records the source has in usage.records. */
export async function saveState(sql: SQL, source: string, u: StateUpdate): Promise<void> {
  await sql`
    INSERT INTO usage.collector_state AS cs (source, cursor, last_run_at, last_status, last_note, records_total)
    VALUES (${source}, ${u.cursor ?? null}, now(), ${u.status}, ${u.note ?? null},
            (SELECT count(*) FROM usage.records WHERE source = ${source}))
    ON CONFLICT (source) DO UPDATE SET
      cursor = CASE WHEN ${u.cursor === undefined}::boolean THEN cs.cursor ELSE EXCLUDED.cursor END,
      last_run_at = EXCLUDED.last_run_at,
      last_status = EXCLUDED.last_status,
      last_note = EXCLUDED.last_note,
      records_total = EXCLUDED.records_total`
}

/** Every stored session_env line (a few thousand rows): the baseline the hook-log scan is merged onto. */
export async function loadSessionEnvTable(
  sql: SQL,
): Promise<
  Array<
    Pick<
      SessionEnvRow,
      'session' | 'base_url' | 'lane' | 'account' | 'factory_role' | 'factory_session'
    >
  >
> {
  const rows =
    await sql`SELECT session, base_url, lane, account, factory_role, factory_session FROM usage.session_env`
  return rows.map((r: Record<string, unknown>) => ({
    session: String(r.session),
    base_url: (r.base_url as string | null) ?? null,
    lane: (r.lane as string | null) ?? null,
    account: parseAccount(r.account),
    factory_role: (r.factory_role as string | null) ?? null,
    factory_session: (r.factory_session as string | null) ?? null,
  }))
}
