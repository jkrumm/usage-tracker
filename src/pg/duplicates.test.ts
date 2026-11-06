import type { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { migratedDb } from './fixture.ts'
import { describePg } from './testing.ts'

// Migrations 0007-0009: the gateway mirror rule marks the later copy of a call that two stores recorded, never deletes, and
// leaves legitimate neighbours alone.

const pg = migratedDb()
let db: SQL

interface R {
  id: string
  source: string
  machine: string
  ts?: string
  model?: string
  key?: string
  input?: number
  output?: number
  reasoning?: number
  write5m?: number
  write1h?: number
  billing?: string
}

async function put(r: R): Promise<number> {
  const [row] = await db`
    INSERT INTO usage.records (source, source_id, grain, ts, model, billing, api_key, machine, input_tokens, output_tokens, reasoning_tokens,
                               cache_write_5m_tokens, cache_write_1h_tokens, cost_usd, cost_source)
    VALUES (${r.source}, ${r.id}, 'message', ${r.ts ?? '2026-10-24T10:00:00Z'}::timestamptz, ${r.model ?? 'claude-opus-5-5'}, ${r.billing ?? 'api_key'},
            ${r.key ?? 'personal'}, ${r.machine}, ${r.input ?? 1000}, ${r.output ?? 200}, ${r.reasoning ?? 0},
            ${r.write5m ?? 0}, ${r.write1h ?? 0}, 1, 'reported')
    RETURNING id::int AS id`
  return row.id
}

const flagged = async () =>
  (await db`SELECT record_id::int AS r, duplicate_of::int AS d FROM usage.record_duplicates ORDER BY 1`) as Array<{
    r: number
    d: number
  }>

beforeEach(async () => {
  db = await pg.reset()
})

describePg('gateway mirror duplicates', () => {
  test('the later copy of a call from another store is marked, the earlier kept, nothing deleted', async () => {
    const keep = await put({ id: 'a', source: 'audio-gateway', machine: 'Mac mini (M2 Pro)' })
    const copy = await put({
      id: 'b',
      source: 'audio-gateway-mini',
      machine: 'mini',
      ts: '2026-10-24T10:00:03Z',
    })
    const other = await put({
      id: 'c',
      source: 'audio-gateway',
      machine: 'mini',
      ts: '2026-10-24T10:00:09Z',
    })
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('2')
    expect(await flagged()).toEqual([
      { r: copy, d: keep },
      { r: other, d: keep },
    ])
    expect((await db`SELECT count(*)::int AS n FROM usage.records`)[0]!.n).toBe(3)
    expect(
      (await db`SELECT id::int AS id FROM usage.records_unique`).map((r: { id: number }) => r.id),
    ).toEqual([keep])
  })

  test('a store that lumps reasoning into output and one that keeps it apart are the same call', async () => {
    const keep = await put({
      id: 'a',
      source: 'audio-gateway',
      machine: 'Mac mini (M2 Pro)',
      output: 871,
      reasoning: 3898,
      write5m: 100,
      write1h: 50,
    })
    const copy = await put({
      id: 'b',
      source: 'audio-gateway-mini',
      machine: 'mini',
      output: 4769,
      reasoning: 0,
      write5m: 150,
      write1h: 0,
    })
    await db`SELECT usage.flag_gateway_duplicates()`
    expect(await flagged()).toEqual([{ r: copy, d: keep }])
  })

  test('a second run changes nothing', async () => {
    await put({ id: 'a', source: 'audio-gateway', machine: 'Mac mini (M2 Pro)' })
    await put({ id: 'b', source: 'audio-gateway-vps', machine: 'vps' })
    await db`SELECT usage.flag_gateway_duplicates()`
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('0')
  })

  test('different token counts, models, keys, a gap above 10 s, the same store or another source are not duplicates', async () => {
    await put({ id: 'base', source: 'audio-gateway', machine: 'Mac mini (M2 Pro)' })
    await put({ id: 'tokens', source: 'audio-gateway-mini', machine: 'mini', output: 201 })
    await put({
      id: 'model',
      source: 'audio-gateway-mini',
      machine: 'mini',
      model: 'claude-haiku-5-5',
    })
    await put({ id: 'key', source: 'audio-gateway-mini', machine: 'mini', key: 'athena-team' })
    await put({
      id: 'late',
      source: 'audio-gateway-mini',
      machine: 'mini',
      ts: '2026-10-24T10:00:13Z',
    })
    await put({
      id: 'same-store',
      source: 'audio-gateway',
      machine: 'Mac mini (M2 Pro)',
      ts: '2026-10-24T10:00:02Z',
    })
    await put({ id: 'elsewhere', source: 'claude-code', machine: 'mini' })
    await put({ id: 'max', source: 'audio-gateway-vps', machine: 'vps', billing: 'max' })
    await put({ id: 'empty-a', source: 'audio-gateway', machine: 'a', input: 0, output: 0 })
    await put({ id: 'empty-b', source: 'audio-gateway-mini', machine: 'b', input: 0, output: 0 })
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('0')
  })

  test('deleting the marks puts the rows back', async () => {
    await put({ id: 'a', source: 'audio-gateway', machine: 'Mac mini (M2 Pro)' })
    await put({ id: 'b', source: 'audio-gateway-mini', machine: 'mini' })
    await db`SELECT usage.flag_gateway_duplicates()`
    expect((await db`SELECT count(*)::int AS n FROM usage.records_unique`)[0]!.n).toBe(1)
    await db`DELETE FROM usage.record_duplicates`
    expect((await db`SELECT count(*)::int AS n FROM usage.records_unique`)[0]!.n).toBe(2)
  })

  // One call is recorded once per store; X is the audio gateway's collector copy, Y its Argo mirror, Z the image gateway's push.
  const X = { source: 'audio-gateway', machine: 'Mac mini (M2 Pro)' }
  const Y = { source: 'audio-gateway-mini', machine: 'mini' }
  const Z = { source: 'image-gen-gateway', machine: 'vps' }

  test('two mirrored calls within 10 s with interleaved ids mark exactly two rows, one per pair', async () => {
    const xa = await put({ id: 'xa', ...X, ts: '2026-10-24T10:00:00Z' })
    const ya = await put({ id: 'ya', ...Y, ts: '2026-10-24T10:00:01Z' })
    const xb = await put({ id: 'xb', ...X, ts: '2026-10-24T10:00:02Z' })
    const yb = await put({ id: 'yb', ...Y, ts: '2026-10-24T10:00:03Z' })
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('2')
    expect(await flagged()).toEqual([
      { r: ya, d: xa },
      { r: yb, d: xb },
    ])
  })

  test('pairing follows the timestamps, not the insert order; the lower id of a pair is kept', async () => {
    const yb = await put({ id: 'yb', ...Y, ts: '2026-10-24T10:00:03Z' })
    const ya = await put({ id: 'ya', ...Y, ts: '2026-10-24T10:00:01Z' })
    const xb = await put({ id: 'xb', ...X, ts: '2026-10-24T10:00:02Z' })
    const xa = await put({ id: 'xa', ...X, ts: '2026-10-24T10:00:00Z' })
    await db`SELECT usage.flag_gateway_duplicates()`
    // (xa, ya) and (xb, yb): yb < ya < xb < xa by id, so yb and ya are kept
    expect(await flagged()).toEqual(
      [
        { r: xb, d: yb },
        { r: xa, d: ya },
      ].sort((a, b) => a.r - b.r),
    )
  })

  test('a row is never both an original and a duplicate, and two calls of one store never merge', async () => {
    const x1 = await put({ id: 'x1', ...X, ts: '2026-10-24T10:00:00Z' })
    const x2 = await put({ id: 'x2', ...X, ts: '2026-10-24T10:00:02Z' })
    const y1 = await put({ id: 'y1', ...Y, ts: '2026-10-24T10:00:03Z' })
    await db`SELECT usage.flag_gateway_duplicates()`
    expect(await flagged()).toEqual([{ r: y1, d: x1 }])
    expect(
      (await db`SELECT count(*)::int AS n FROM usage.records_unique WHERE id = ${x2}`)[0]!.n,
    ).toBe(1)
    expect(
      (
        await db`SELECT count(*)::int AS n FROM usage.record_duplicates a JOIN usage.record_duplicates b ON a.duplicate_of = b.record_id`
      )[0]!.n,
    ).toBe(0)
  })

  test('a call recorded by three stores keeps one row and marks the two other copies', async () => {
    const x = await put({ id: 'x', ...X, ts: '2026-10-24T10:00:00Z' })
    const y = await put({ id: 'y', ...Y, ts: '2026-10-24T10:00:01Z' })
    const z = await put({ id: 'z', ...Z, ts: '2026-10-24T10:00:02Z' })
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('2')
    expect(await flagged()).toEqual([
      { r: y, d: x },
      { r: z, d: x },
    ])
  })

  test('rows already in a pair are left alone, so a re-run after more rows arrive keeps the earlier marks', async () => {
    const x = await put({ id: 'x', ...X, ts: '2026-10-24T10:00:00Z' })
    const y = await put({ id: 'y', ...Y, ts: '2026-10-24T10:00:01Z' })
    await db`SELECT usage.flag_gateway_duplicates()`
    const before = await db`SELECT record_id, duplicate_of, flagged_at FROM usage.record_duplicates`
    const x2 = await put({ id: 'x2', ...X, ts: '2026-10-24T10:00:02Z' })
    const y2 = await put({ id: 'y2', ...Y, ts: '2026-10-24T10:00:03Z' })
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe('1')
    expect(await flagged()).toEqual([
      { r: y, d: x },
      { r: y2, d: x2 },
    ])
    expect(
      (
        await db`SELECT record_id, duplicate_of, flagged_at FROM usage.record_duplicates WHERE record_id = ${y}`
      )[0],
    ).toEqual(before[0])
  })
})

// Migration 0018: the cutover rules and migration 0017's cutoff on records_unique.

async function putRaw(r: {
  source: string
  id: string
  ts: string
  runId?: string
  detail?: object
  raw?: object
}): Promise<number> {
  const [row] = await db`
    INSERT INTO usage.records (source, source_id, grain, ts, billing, lane, run_id, lane_detail, raw, input_tokens, cost_usd, cost_source)
    VALUES (${r.source}, ${r.id}, 'message', ${r.ts}::timestamptz, 'unknown', 'other', ${r.runId ?? null},
            ${r.detail ? JSON.stringify(r.detail) : null}::text::jsonb, ${r.raw ? JSON.stringify(r.raw) : null}::text::jsonb, 10, 1, 'reported')
    RETURNING id::int AS id`
  return row.id
}

const ok = { status: 200, usageReported: true }

describePg('cutover duplicates', () => {
  test('gateway-hermes: hermes rows from the first gateway hermes row on, older ones stay', async () => {
    const gw = await putRaw({
      source: 'gateway',
      id: 'g1',
      ts: '2026-11-02T07:00:00Z',
      detail: { caller: 'hermes' },
    })
    await putRaw({
      source: 'gateway',
      id: 'g0',
      ts: '2026-11-01T07:00:00Z',
      detail: { caller: 'iris' },
    })
    await putRaw({ source: 'hermes', id: 'before', ts: '2026-11-01T23:00:00Z' })
    const after = await putRaw({ source: 'hermes', id: 'after', ts: '2026-11-03T07:00:00Z' })
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(1)
    expect(
      Array.from(
        await db`SELECT record_id::int AS r, duplicate_of::int AS d, rule FROM usage.record_duplicates`,
      ),
    ).toEqual([{ r: after, d: gw, rule: 'gateway-hermes' }])
  })

  test('gateway-cutover: agent-workflows rows whose run has a reported 200 gateway row', async () => {
    const gw = await putRaw({
      source: 'gateway',
      id: 'g',
      ts: '2026-11-02T10:00:00Z',
      runId: 'run-1',
      raw: ok,
    })
    await putRaw({
      source: 'gateway',
      id: 'g-fail',
      ts: '2026-11-02T10:00:00Z',
      runId: 'run-2',
      raw: { status: 500, usageReported: true },
    })
    await putRaw({
      source: 'gateway',
      id: 'g-nousage',
      ts: '2026-11-02T10:00:00Z',
      runId: 'run-3',
      raw: { status: 200, usageReported: false },
    })
    const dup = await putRaw({
      source: 'agent-workflows',
      id: 'a1',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-1',
    })
    await putRaw({
      source: 'agent-workflows',
      id: 'a2',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-2',
    })
    await putRaw({
      source: 'agent-workflows',
      id: 'a3',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-3',
    })
    await putRaw({
      source: 'agent-workflows',
      id: 'a4',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-9',
    })
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(1)
    expect(
      Array.from(
        await db`SELECT record_id::int AS r, duplicate_of::int AS d, rule FROM usage.record_duplicates`,
      ),
    ).toEqual([{ r: dup, d: gw, rule: 'gateway-cutover' }])
  })

  test('gateway-cutover keeps a tools row: the gateway never saw the search fee', async () => {
    await putRaw({
      source: 'gateway',
      id: 'g',
      ts: '2026-11-02T10:00:00Z',
      runId: 'run-1',
      raw: ok,
    })
    await putRaw({
      source: 'agent-workflows',
      id: 'fee',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-1',
      detail: { step: 'tools' },
    })
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(0)
  })

  test('idempotent, and a second call after new rows marks only the new ones', async () => {
    await putRaw({
      source: 'gateway',
      id: 'g',
      ts: '2026-11-02T10:00:00Z',
      runId: 'run-1',
      raw: ok,
      detail: { caller: 'hermes' },
    })
    await putRaw({ source: 'hermes', id: 'h1', ts: '2026-11-03T07:00:00Z' })
    await putRaw({
      source: 'agent-workflows',
      id: 'a1',
      ts: '2026-11-02T10:00:01Z',
      runId: 'run-1',
    })
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(2)
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(0)
    await putRaw({ source: 'hermes', id: 'h2', ts: '2026-11-04T07:00:00Z' })
    expect((await db`SELECT usage.flag_cutover_duplicates()::int AS n`)[0].n).toBe(1)
  })

  test('records_unique hides marked rows and everything before 2026-06-15, usage.records keeps them', async () => {
    await putRaw({ source: 'x', id: 'old', ts: '2026-06-14T23:59:59Z' })
    await putRaw({ source: 'x', id: 'edge', ts: '2026-06-15T00:00:00Z' })
    await putRaw({
      source: 'gateway',
      id: 'g',
      ts: '2026-11-02T07:00:00Z',
      detail: { caller: 'hermes' },
    })
    await putRaw({ source: 'hermes', id: 'h', ts: '2026-11-03T07:00:00Z' })
    await db`SELECT usage.flag_cutover_duplicates()`
    const unique = await db`SELECT source_id FROM usage.records_unique ORDER BY source_id`
    expect(unique.map((r: { source_id: string }) => r.source_id)).toEqual(['edge', 'g'])
    expect((await db`SELECT count(*)::int AS n FROM usage.records`)[0].n).toBe(4)
  })
})
