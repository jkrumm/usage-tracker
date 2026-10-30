import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from '../pg/fixture.ts'
import { describePg } from '../pg/testing.ts'
import { upsertRecords } from '../pg/writer.ts'
import type { Logger } from '../types.ts'
import {
  emailGatewayCollector,
  HISTORY_FLOOR_MS,
  parseSpans,
  sshQuery,
  toRecord,
  type SpanRow,
} from './email-gateway.ts'

process.env.USAGE_MACHINE = 'Test Machine (Override)'
const log: Logger = { info() {}, warn() {}, error() {} }

const span = (over: Partial<SpanRow> = {}): SpanRow => ({
  ts_ms: Date.parse('2026-10-28T09:45:17.039Z'),
  TraceId: 'de9300a17e88c253f79c547647491051',
  SpanId: '829bc3de04091906',
  SpanName: 'llm.classify',
  Duration: 1229350285,
  StatusCode: 'Unset',
  model: 'gpt-6-luna',
  input_tokens: '606',
  output_tokens: '57',
  cache_read_tokens: '0',
  outcome: 'ok',
  ...over,
})

// ClickHouse JSONEachRow as `docker exec clickhouse-client` prints it (64-bit ints quoted or not).
const FIXTURE = [
  `{"ts_ms":"1793180717039","TraceId":"de9300a17e88c253f79c547647491051","SpanId":"829bc3de04091906","SpanName":"llm.classify","Duration":"1229350285","StatusCode":"Unset","model":"gpt-6-luna","input_tokens":"606","output_tokens":"57","cache_read_tokens":"0","outcome":"ok"}`,
  `{"ts_ms":1793180723509,"TraceId":"749742da5785466cb2f2a9fe5f63f035","SpanId":"7dd3f73ee55d8e3c","SpanName":"llm.jev","Duration":314380332,"StatusCode":"Unset","model":"pplx-decider-v1-27b","input_tokens":"553","output_tokens":"1","cache_read_tokens":"0","outcome":"ok"}`,
  '',
].join('\n')

describe('email-gateway collector', () => {
  test('parses ClickHouse JSONEachRow output into records: tokens as-is, lane in subTool, no cache write', () => {
    const records = parseSpans(FIXTURE).map(toRecord)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      sourceId: 'de9300a17e88c253f79c547647491051:829bc3de04091906',
      grain: 'message',
      ts: '2026-10-28T09:45:17.039Z',
      model: 'gpt-6-luna',
      subTool: 'llm:classify',
      inputTokens: 606,
      outputTokens: 57,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 1229,
      outcome: 'ok',
    })
    expect(records[1]).toMatchObject({
      subTool: 'llm:jev',
      model: 'pplx-decider-v1-27b',
      inputTokens: 553,
      outputTokens: 1,
      durationMs: 314,
    })
    expect(parseSpans('')).toEqual([])
  })

  test('an error span (outcome attribute or span status) is an error row; missing attributes count as zero', () => {
    expect(toRecord(span({ outcome: 'error' })).outcome).toBe('error')
    expect(toRecord(span({ outcome: '', StatusCode: 'Error' })).outcome).toBe('error')
    const bare = toRecord(
      span({ model: '', input_tokens: '', output_tokens: '', cache_read_tokens: '7', Duration: 0 }),
    )
    expect(bare).toMatchObject({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 7,
      durationMs: null,
    })
  })

  test('first run reads everything, later runs overlap one day behind the newest span, --full starts over', async () => {
    const seen: number[] = []
    const c = emailGatewayCollector(async (since) => {
      seen.push(since)
      return parseSpans(FIXTURE)
    })
    const first = await c.collect({ cursor: null, full: false, log })
    expect(seen[0]).toBe(HISTORY_FLOOR_MS)
    expect(JSON.parse(first.cursor!)).toEqual({ newest: '2026-10-28T09:45:23.509Z' })
    await c.collect({ cursor: first.cursor, full: false, log })
    expect(seen[1]).toBe(Date.parse('2026-10-27T09:45:23.509Z'))
    await c.collect({ cursor: first.cursor, full: true, log })
    expect(seen[2]).toBe(HISTORY_FLOOR_MS)
  })

  test('an empty result is fine and keeps the cursor; a re-read span or a duplicate row is one record', async () => {
    const empty = emailGatewayCollector(async () => [])
    const out = await empty.collect({
      cursor: JSON.stringify({ newest: '2026-10-28T09:45:23.509Z' }),
      full: false,
      log,
    })
    expect(out.records).toEqual([])
    expect(out.note).toBeUndefined()
    expect(JSON.parse(out.cursor!)).toEqual({ newest: '2026-10-28T09:45:23.509Z' })
    expect(JSON.parse((await empty.collect({ cursor: null, full: false, log })).cursor!)).toEqual({
      newest: null,
    })

    const dup = emailGatewayCollector(async () => [span(), span()])
    expect((await dup.collect({ cursor: null, full: false, log })).records).toHaveLength(1)
  })

  test('a span without ids or a timestamp is skipped and logged, the rest lands', async () => {
    const warned: string[] = []
    const c = emailGatewayCollector(async () => [
      span({ TraceId: '' }),
      span({ ts_ms: 'x', SpanId: 'b' }),
      span({ SpanId: 'c' }),
    ])
    const out = await c.collect({
      cursor: null,
      full: false,
      log: { ...log, warn: (m) => warned.push(m) },
    })
    expect(out.records.map((r) => r.sourceId)).toEqual(['de9300a17e88c253f79c547647491051:c'])
    expect(warned).toHaveLength(2)
  })

  test("spans before Argo's history ends (counted there already) and spans from the future are dropped and never move the cursor", async () => {
    const old = span({ SpanId: 'old', ts_ms: Date.parse('2026-10-24T09:45:17.039Z') })
    const future = span({ SpanId: 'future', ts_ms: Date.now() + 86_400_000 })
    const out = await emailGatewayCollector(async () => [
      old,
      future,
      span({ SpanId: 'ok' }),
    ]).collect({ cursor: null, full: false, log })
    expect(out.records.map((r) => r.sourceId)).toEqual(['de9300a17e88c253f79c547647491051:ok'])
    expect(JSON.parse(out.cursor!)).toEqual({ newest: '2026-10-28T09:45:17.039Z' })
  })

  test('an unreachable VPS surfaces as a rejected collect (the ingest loop records it as a collector error)', async () => {
    const c = emailGatewayCollector(async () => {
      throw new Error('ssh vps exited 255: Could not resolve hostname vps')
    })
    await expect(c.collect({ cursor: null, full: false, log })).rejects.toThrow('exited 255')
  })

  describe('transport', () => {
    const withSsh = async (script: string, run: () => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'usage-tracker-ssh-'))
      const bin = join(dir, 'ssh')
      writeFileSync(bin, `#!/bin/sh\n${script}\n`)
      chmodSync(bin, 0o755)
      process.env.EMAIL_GATEWAY_SSH = bin
      try {
        await run()
      } finally {
        delete process.env.EMAIL_GATEWAY_SSH
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test('a non-zero ssh exit throws with the last stderr line', async () => {
      await withSsh(
        `echo "ssh: connect to host vps port 22: Connection refused" >&2; exit 255`,
        async () => {
          await expect(sshQuery(0)).rejects.toThrow(
            'exited 255: ssh: connect to host vps port 22: Connection refused',
          )
        },
      )
    })

    test('sends the SQL on stdin and parses stdout; the since bound is spliced as a number', async () => {
      await withSsh(`cat > "$0.sql"; echo '${FIXTURE.split('\n')[0]}'`, async () => {
        const rows = await sshQuery(1792000000000)
        expect(rows).toHaveLength(1)
        const sql = await Bun.file(`${process.env.EMAIL_GATEWAY_SSH}.sql`).text()
        expect(sql).toContain("ServiceName = 'email-gateway'")
        expect(sql).toContain('fromUnixTimestamp64Milli(1792000000000)')
      })
    })
  })

  describePg('into the table (Postgres)', () => {
    const pg = migratedDb()

    test('rows are billing=api_key on the personal key, lane per the existing mapping, an unpriced model is NULL/none, a re-read changes nothing', async () => {
      const db = await pg.reset()
      const records = parseSpans(FIXTURE).map(toRecord)
      expect(
        (await upsertRecords(db, 'email-gateway', records, { defaultWorkspace: 'private' }))
          .newRows,
      ).toBe(2)
      expect(
        (await upsertRecords(db, 'email-gateway', records, { defaultWorkspace: 'private' }))
          .newRows,
      ).toBe(0)
      const rows = [
        ...(await db`SELECT model_raw, billing, account, api_key, lane, lane_detail, workspace, input_tokens::int AS inp, cost_source, cost_usd
                     FROM usage.records WHERE source = 'email-gateway' ORDER BY ts`),
      ]
      expect(rows).toHaveLength(2)
      for (const r of rows)
        expect(r).toMatchObject({
          billing: 'api_key',
          account: null,
          api_key: 'personal',
          lane: 'other',
          workspace: 'private',
        })
      expect(rows[0].lane_detail).toEqual({ raw: 'llm:classify' })
      expect(rows[1]).toMatchObject({
        model_raw: 'pplx-decider-v1-27b',
        inp: 553,
        cost_source: 'none',
        cost_usd: null,
      })
    })
  })
})
