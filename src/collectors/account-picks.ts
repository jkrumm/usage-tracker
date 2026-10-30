import type { SQL } from 'bun'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { currentMachine } from '../machine.ts'
import { parseAccount } from '../models.ts'
import { loadCursor, saveState } from '../pg/state.ts'
import { readNewLines } from './fs-incremental.ts'

// The dotfiles account picker appends one JSON line per decision to picks.jsonl.
// Read incrementally by byte offset (kept in usage.collector_state under CURSOR_KEY,
// like the other file collectors) into usage.account_picks.

const CURSOR_KEY = 'account-picks'

function picksPath(): string {
  return (
    process.env.USAGE_ACCOUNT_PICKS ??
    join(homedir(), '.local', 'share', 'claude-accounts', 'picks.jsonl')
  )
}

interface PickLine {
  ts: string
  lane: string
  picked: string
  reason: string
  stale?: boolean
  [account: string]: unknown
}

/** Legacy account ids a/b -> iu/me; anything else (incl. the `spill` sentinel) is kept verbatim. */
const canonicalId = (id: string): string => parseAccount(id) ?? id

/** Parse a picks.jsonl line into a row, or null when malformed. */
export function parsePick(line: string): {
  ts: number
  lane: string
  picked: string
  reason: string
  stale: boolean
  snapshot: Record<string, unknown>
} | null {
  let p: PickLine
  try {
    p = JSON.parse(line) as PickLine
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  const ts = typeof p.ts === 'string' ? Date.parse(p.ts) : Number.NaN
  if (Number.isNaN(ts) || typeof p.lane !== 'string' || typeof p.picked !== 'string') return null
  const { ts: _ts, lane: _lane, picked: _picked, reason: _reason, stale: _stale, ...rest } = p
  const snapshot = Object.fromEntries(Object.entries(rest).map(([k, v]) => [canonicalId(k), v]))
  return {
    ts,
    lane: p.lane,
    picked: canonicalId(p.picked),
    reason: typeof p.reason === 'string' ? p.reason : '',
    stale: Boolean(p.stale),
    snapshot,
  }
}

/** Ingest new picks; returns the number of new rows. The rows and the advanced offset land in one transaction. */
export async function collectPicks(sql: SQL, opts: { full?: boolean } = {}): Promise<number> {
  const path = picksPath()
  if (!existsSync(path)) return 0

  const size = statSync(path).size
  let from = opts.full ? 0 : Number.parseInt((await loadCursor(sql, CURSOR_KEY)) ?? '0', 10) || 0
  if (size < from) from = 0 // truncated or rotated

  const chunk = await readNewLines(path, from, size)
  const offset = chunk?.offset ?? from

  const machine = currentMachine()
  const rows: Array<Record<string, unknown>> = []
  for (const line of chunk?.lines ?? []) {
    const pick = parsePick(line)
    if (!pick) continue
    rows.push({
      ts: new Date(pick.ts).toISOString(),
      lane: pick.lane,
      picked: pick.picked,
      reason: pick.reason,
      stale: pick.stale,
      snapshot: pick.snapshot,
      machine,
    })
  }

  return sql.begin(async (tx) => {
    let added = 0
    if (rows.length > 0) {
      const inserted = await tx`
        INSERT INTO usage.account_picks (ts, lane, picked, reason, stale, snapshot, machine)
        SELECT ts, lane, picked, reason, stale, snapshot, machine
        FROM jsonb_to_recordset(${JSON.stringify(rows).replace(/\\u0000/g, '')}::text::jsonb) AS j(
          ts timestamptz, lane text, picked text, reason text, stale boolean, snapshot jsonb, machine text)
        ORDER BY ts, lane
        ON CONFLICT (ts, lane, machine) DO NOTHING
        RETURNING 1`
      added = inserted.length
    }
    await saveState(tx, CURSOR_KEY, { cursor: String(offset), status: 'ok' })
    return added
  })
}
