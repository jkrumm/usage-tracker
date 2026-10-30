import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { importState, sqliteTime, toAccountPick, toQuotaSample } from './backfill-state.ts'
import { migratedDb } from './pg/fixture.ts'
import { describePg } from './pg/testing.ts'

const archive = (): Database => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE collector_state (source TEXT PRIMARY KEY, cursor TEXT, last_run_at TEXT, last_status TEXT, last_note TEXT, records_total INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE session_env (session TEXT PRIMARY KEY, base_url TEXT, lane TEXT, seen_at TEXT NOT NULL, account TEXT);
    CREATE TABLE quota_sample (account TEXT NOT NULL, sampled_at INTEGER NOT NULL, machine TEXT NOT NULL, five_hour_pct INTEGER, seven_day_pct INTEGER,
      five_hour_resets_at INTEGER, seven_day_resets_at INTEGER, auth_ok INTEGER, exhausted_until INTEGER, source TEXT, synced INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, sampled_at, machine));
    CREATE TABLE account_pick (ts INTEGER NOT NULL, lane TEXT NOT NULL, picked TEXT NOT NULL, reason TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
      snapshot TEXT, machine TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ts, lane, machine));
    CREATE TABLE iu_portal_cost (iu_key TEXT NOT NULL DEFAULT 'personal', day TEXT NOT NULL, label TEXT NOT NULL, row INTEGER NOT NULL, model TEXT,
      cost_usd REAL NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (iu_key, day, label, row));
    CREATE TABLE iu_portal_total (iu_key TEXT NOT NULL DEFAULT 'personal', month TEXT NOT NULL, total_usd REAL NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (iu_key, month));
    INSERT INTO collector_state VALUES ('claude-code', '{"/a":10}', '2026-10-30 12:09:58', 'ok', NULL, 5), ('argo_portal_fetched_at', '1', '2026-10-30 11:09:04', 'ok', 'x', 0);
    INSERT INTO session_env VALUES ('s1', 'https://iu/openai', 'wave', '2026-10-10T23:35:09.818Z', 'me'), ('s2', NULL, NULL, '2026-10-10T23:35:09.818Z', NULL);
    INSERT INTO quota_sample VALUES ('iu', 1792861119642, 'mini', 10, 88, 1792867800, 1793203200, 1, NULL, 'statusline', 1), ('me', 1792861119642, 'mini', 150, NULL, NULL, NULL, 0, 1792870000, NULL, 0);
    INSERT INTO account_pick VALUES (1792859240013, 'fan', 'me', 'home', 1, '{"iu":{"s":9,"w":88}}', 'mini', 1), (1792859240014, 'fan', 'spill', 'x', 0, NULL, 'mini', 0);
    INSERT INTO iu_portal_cost VALUES ('personal', '2026-09-26', 'Gpt 5.6 Terra', 105, 'gpt-5.6-terra', 0.64, 1793043404267);
    INSERT INTO iu_portal_total VALUES ('personal', '2026-10', 596.46, 1793357543794);
  `)
  return db
}

test('SQLite times and flags convert to timestamptz and boolean', () => {
  expect(sqliteTime('2026-10-30 12:09:58')).toBe('2026-10-30T12:09:58.000Z')
  expect(sqliteTime('2026-10-10T23:35:09.818Z')).toBe('2026-10-10T23:35:09.818Z')
  expect(sqliteTime('')).toBeNull()
  expect(
    toQuotaSample({
      account: 'iu',
      sampled_at: 1792861119642,
      machine: 'm',
      five_hour_pct: 150,
      seven_day_pct: 7,
      five_hour_resets_at: 1792867800,
      auth_ok: 0,
      exhausted_until: null,
    }),
  ).toMatchObject({
    sampled_at: '2026-10-24T16:58:39.642Z',
    five_hour_pct: null,
    seven_day_pct: 7,
    five_hour_resets_at: '2026-10-24T18:50:00.000Z',
    auth_ok: false,
    exhausted_until: null,
  })
  expect(
    toAccountPick({
      ts: 1792859240013,
      lane: 'fan',
      picked: 'me',
      reason: 'home',
      stale: 1,
      snapshot: '{"a":1}',
      machine: 'm',
    }),
  ).toMatchObject({ stale: true, snapshot: { a: 1 } })
  expect(
    toAccountPick({
      ts: 1,
      lane: 'l',
      picked: 'p',
      reason: 'r',
      stale: 0,
      snapshot: '{broken',
      machine: 'm',
    }).snapshot,
  ).toBeNull()
})

describePg('importing the SQLite state tables', () => {
  const pg = migratedDb()

  test('imports every table, skips the retired Argo bookkeeping, and a re-run adds nothing', async () => {
    const sql = await pg.reset()
    const db = archive()
    const first = await importState(db, sql)
    expect(first.collector_state).toEqual({
      read: 2,
      added: 1,
      skipped: ['argo_portal_fetched_at'],
    })
    expect([
      first.session_env.added,
      first.quota_samples.added,
      first.account_picks.added,
      first.iu_portal_cost.added,
      first.iu_portal_total.added,
    ]).toEqual([2, 2, 2, 1, 1])
    const [cs] =
      await sql`SELECT cursor, last_run_at, records_total::int AS n FROM usage.collector_state WHERE source = 'claude-code'`
    expect(cs).toMatchObject({
      cursor: '{"/a":10}',
      last_run_at: new Date('2026-10-30T12:09:58Z'),
      n: 5,
    })
    const [q] =
      await sql`SELECT five_hour_pct, auth_ok, exhausted_until FROM usage.quota_samples WHERE account = 'me'`
    expect(q).toMatchObject({
      five_hour_pct: null,
      auth_ok: false,
      exhausted_until: new Date(1792870000 * 1000),
    })
    const [p] =
      await sql`SELECT stale, snapshot FROM usage.account_picks WHERE lane = 'fan' AND picked = 'me'`
    expect(p).toMatchObject({ stale: true, snapshot: { iu: { s: 9, w: 88 } } })

    const second = await importState(db, sql)
    expect([
      second.collector_state.added,
      second.session_env.added,
      second.quota_samples.added,
      second.account_picks.added,
      second.iu_portal_cost.added,
      second.iu_portal_total.added,
    ]).toEqual([0, 0, 0, 0, 0, 0])
  }, 60_000)

  test('a re-run never overwrites a cursor or a newer line written since', async () => {
    const sql = await pg.reset()
    const db = archive()
    await importState(db, sql)
    await sql`UPDATE usage.collector_state SET cursor = 'newer' WHERE source = 'claude-code'`
    await sql`UPDATE usage.session_env SET base_url = 'fresh', seen_at = '2026-10-31T00:00:00Z' WHERE session = 's1'`
    await sql`UPDATE usage.iu_portal_total SET total_usd = 700, fetched_at = '2026-10-31T00:00:00Z' WHERE month = '2026-10'`
    await importState(db, sql)
    expect(
      (await sql`SELECT cursor FROM usage.collector_state WHERE source = 'claude-code'`)[0].cursor,
    ).toBe('newer')
    expect(
      (await sql`SELECT base_url FROM usage.session_env WHERE session = 's1'`)[0].base_url,
    ).toBe('fresh')
    // a line the pipeline wrote since, stamped with its own (newer) time, survives the archive's older one, lane included
    await sql`UPDATE usage.session_env SET base_url = 'live', lane = 'bg', seen_at = '2026-10-30T13:00:00Z' WHERE session = 's2'`
    await importState(db, sql)
    expect(
      (await sql`SELECT base_url, lane, seen_at FROM usage.session_env WHERE session = 's2'`)[0],
    ).toMatchObject({ base_url: 'live', lane: 'bg', seen_at: new Date('2026-10-30T13:00:00Z') })
    expect(Number((await sql`SELECT total_usd FROM usage.iu_portal_total`)[0].total_usd)).toBe(700)
  }, 60_000)
})
