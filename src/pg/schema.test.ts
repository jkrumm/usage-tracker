import { expect, test } from 'bun:test'
import { LANES } from '../lane.ts'
import { migrate } from './migrate.ts'
import { describePg, scratchDb } from './testing.ts'

describePg('usage schema constraints', () => {
  const db = scratchDb()
  const fails = async (run: () => Promise<unknown>) => {
    await expect(run()).rejects.toThrow()
  }

  test('a record is unique on (source, source_id); machine is only an attribute', async () => {
    const sql = await db.connect()
    await migrate(sql)
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, machine) VALUES ('claude-code', 'req_1', 'message', now(), 'mini')`
    await fails(async () => {
      await sql`INSERT INTO usage.records (source, source_id, grain, ts, machine) VALUES ('claude-code', 'req_1', 'message', now(), 'macbook')`
    })
    const rows = await sql`
      INSERT INTO usage.records (source, source_id, grain, ts, machine) VALUES ('claude-code', 'req_1', 'message', now(), 'macbook')
      ON CONFLICT (source, source_id) DO UPDATE SET machine = EXCLUDED.machine RETURNING machine`
    expect(rows[0].machine).toBe('macbook')
  })

  test('the lane vocabulary is a CHECKed set on sessions and records', async () => {
    const sql = await db.connect()
    for (const lane of LANES) {
      await sql`INSERT INTO usage.sessions (source, source_session_id, lane) VALUES ('t', ${`s-${lane}`}, ${lane})`
    }
    await fails(async () => {
      await sql`INSERT INTO usage.sessions (source, source_session_id, lane) VALUES ('t', 'bad', 'wave')`
    })
    await fails(async () => {
      await sql`INSERT INTO usage.records (source, source_id, grain, ts, lane) VALUES ('t', 'bad', 'message', now(), 'wave')`
    })
  })

  test('a session is unique per source and a record can point at it', async () => {
    const sql = await db.connect()
    await fails(async () => {
      await sql`INSERT INTO usage.sessions (source, source_session_id, lane) VALUES ('t', 's-worker', 'worker')`
    })
    const [s] = await sql`SELECT id FROM usage.sessions WHERE source_session_id = 's-worker'`
    await sql`INSERT INTO usage.sessions (source, source_session_id, lane, parent_session_id) VALUES ('t', 'child', 'subagent', ${s.id})`
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, session_id, cache_write_5m_tokens, cache_write_1h_tokens)
              VALUES ('t', 'r-session', 'message', now(), ${s.id}, 10, 20)`
    const [r] =
      await sql`SELECT cache_write_5m_tokens, cache_write_1h_tokens, cost_source, billing FROM usage.records WHERE source_id = 'r-session'`
    expect(r).toMatchObject({
      cache_write_5m_tokens: '10',
      cache_write_1h_tokens: '20',
      cost_source: 'none',
      billing: 'unknown',
    })
  })

  test('quota samples and picks key like the SQLite tables', async () => {
    const sql = await db.connect()
    await sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct, seven_day_pct) VALUES ('iu', '2026-10-30T10:00:00Z', 'mini', 40, 12)`
    await fails(async () => {
      await sql`INSERT INTO usage.quota_samples (account, sampled_at, machine, five_hour_pct) VALUES ('iu', '2026-10-30T10:00:00Z', 'mini', 41)`
    })
    await sql`INSERT INTO usage.account_picks (ts, lane, picked, reason, machine, snapshot) VALUES ('2026-10-30T10:00:00Z', 'wave', 'spill', 'no room', 'mini', ${JSON.stringify({ iu: { s: 90, w: 50 } })}::text::jsonb)`
    const [p] = await sql`SELECT snapshot->'iu'->>'s' AS s FROM usage.account_picks`
    expect(p.s).toBe('90')
  })

  test('api_credit is an accepted billing class on records and sessions; an unknown value is still refused', async () => {
    const sql = await db.connect()
    await sql`INSERT INTO usage.sessions (source, source_session_id, lane, billing, account) VALUES ('gateway', 's-credit', 'other', 'api_credit', 'me')`
    await sql`INSERT INTO usage.records (source, source_id, grain, ts, billing, account) VALUES ('gateway', 'r-credit', 'message', now(), 'api_credit', 'me2')`
    const [r] = await sql`SELECT billing, account FROM usage.records WHERE source_id = 'r-credit'`
    expect(r).toMatchObject({ billing: 'api_credit', account: 'me2' })
    for (const billing of ['max', 'api_key', 'unknown']) {
      await sql`INSERT INTO usage.records (source, source_id, grain, ts, billing) VALUES ('t', ${`r-${billing}`}, 'message', now(), ${billing})`
    }
    await fails(async () => {
      await sql`INSERT INTO usage.records (source, source_id, grain, ts, billing) VALUES ('gateway', 'r-bad', 'message', now(), 'iu')`
    })
    await fails(async () => {
      await sql`INSERT INTO usage.sessions (source, source_session_id, lane, billing) VALUES ('gateway', 's-bad', 'other', 'credit')`
    })
  })

  test('credit cycles key on (account, cycle_start) and may be open; gateway picks key on (ts, caller, request_id)', async () => {
    const sql = await db.connect()
    await sql`INSERT INTO usage.credit_cycles (account, cycle_start, grant_usd, metered_usd) VALUES ('me', '2026-10-01T00:00:00Z', 200, 12.5)`
    await sql`INSERT INTO usage.credit_cycles (account, cycle_start, cycle_end, grant_usd, metered_usd, reconciled_usd, unspent_usd, closed_at)
              VALUES ('me', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 200, 150, 149.2, 50.8, '2026-10-01T01:00:00Z')`
    await fails(async () => {
      await sql`INSERT INTO usage.credit_cycles (account, cycle_start, grant_usd, metered_usd) VALUES ('me', '2026-10-01T00:00:00Z', 200, 1)`
    })
    const [open] =
      await sql`SELECT cycle_end, reconciled_usd, unspent_usd, closed_at FROM usage.credit_cycles WHERE cycle_start = '2026-10-01T00:00:00Z'`
    expect(open).toEqual({
      cycle_end: null,
      reconciled_usd: null,
      unspent_usd: null,
      closed_at: null,
    })

    await sql`INSERT INTO usage.gateway_picks (ts, caller, session, picked, reason, machine, request_id) VALUES ('2026-10-30T10:00:00Z', 'agw', NULL, 'iu', 'pool exhausted', 'mini', 'req_1')`
    await sql`INSERT INTO usage.gateway_picks (ts, caller, session, picked, reason, machine, request_id) VALUES ('2026-10-30T10:00:00Z', 'agw', 's1', 'refused', 'no budget', 'mini', 'req_2')`
    await fails(async () => {
      await sql`INSERT INTO usage.gateway_picks (ts, caller, picked, reason, machine, request_id) VALUES ('2026-10-30T10:00:00Z', 'agw', 'iu', 'dup', 'mini', 'req_1')`
    })
  })
})
