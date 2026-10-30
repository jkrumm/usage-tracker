import type { SQL } from 'bun'
import type { SessionEvent } from '../types.ts'
import { eventSessionKey } from './sessions.ts'
import { payload } from './writer.ts'

// The Postgres write path for usage.session_events (docs/usage-schema.md §Session events): compactions and skill loads.
// One event can arrive in two halves (a skill's call, and the line that shows its loaded size, maybe polls apart); both
// carry the same event id and the conflict clause merges them, in either order.

/** Rows per round trip. */
const CHUNK = 500

interface Row {
  event_id: string
  source_session_id: string
  kind: string
  ts: string
  name?: string
  size_chars?: number
  detail?: Record<string, unknown>
}

function toRow(e: SessionEvent): Row {
  return {
    event_id: e.eventId,
    source_session_id: eventSessionKey(e),
    kind: e.kind,
    ts: e.ts,
    name: e.name,
    size_chars: e.sizeChars,
    detail: e.detail,
  }
}

/** The same merge the database does on conflict: a present value beats a missing one (the later half wins), the earlier ts wins. */
function merge(a: Row, b: Row): Row {
  return {
    ...a,
    ts: Date.parse(b.ts) < Date.parse(a.ts) ? b.ts : a.ts,
    name: b.name ?? a.name,
    size_chars: b.size_chars ?? a.size_chars,
    detail: b.detail ?? a.detail,
  }
}

// Written on conflict only when a merged content column differs, so ingested_at moves on real change (a --full re-scan
// is a no-op). kind and source_session_id are the event's identity and never change.
const EVENTS_SQL = `
WITH up AS (
  INSERT INTO usage.session_events AS t (source, event_id, source_session_id, kind, ts, name, size_chars, detail)
  SELECT $2::text, e.event_id, e.source_session_id, e.kind, e.ts, e.name, e.size_chars, e.detail
  FROM jsonb_to_recordset($1::text::jsonb) AS e(
         event_id text, source_session_id text, kind text, ts timestamptz, name text, size_chars integer, detail jsonb)
  ORDER BY e.event_id
  ON CONFLICT (source, event_id) DO UPDATE SET
    ts = least(EXCLUDED.ts, t.ts),
    name = coalesce(EXCLUDED.name, t.name),
    size_chars = coalesce(EXCLUDED.size_chars, t.size_chars),
    detail = coalesce(EXCLUDED.detail, t.detail),
    ingested_at = now()
  WHERE (t.ts, t.name, t.size_chars, t.detail) IS DISTINCT FROM
        (least(EXCLUDED.ts, t.ts), coalesce(EXCLUDED.name, t.name), coalesce(EXCLUDED.size_chars, t.size_chars), coalesce(EXCLUDED.detail, t.detail))
  RETURNING 1
)
SELECT count(*)::int AS written FROM up`

/** Upsert the events of one collector run; returns the rows inserted or changed. Duplicate event ids in the batch are merged first. */
export async function upsertSessionEvents(
  sql: SQL,
  source: string,
  events: SessionEvent[],
): Promise<number> {
  const byId = new Map<string, Row>()
  for (const e of events) {
    const row = toRow(e)
    const prev = byId.get(row.event_id)
    byId.set(row.event_id, prev ? merge(prev, row) : row)
  }
  const rows = [...byId.values()]
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const [counts] = await sql.unsafe(EVENTS_SQL, [payload(rows.slice(i, i + CHUNK)), source])
    written += Number(counts.written)
  }
  return written
}
