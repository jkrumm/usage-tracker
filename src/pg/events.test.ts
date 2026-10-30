import { beforeEach, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import type { SessionEvent } from '../types.ts'
import { upsertSessionEvents } from './events.ts'
import { migratedDb } from './fixture.ts'
import { describePg } from './testing.ts'

const call = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  eventId: 'toolu_1',
  sessionId: 's1',
  kind: 'skill',
  ts: '2026-10-30T10:00:00.000Z',
  name: 'alpha',
  ...over,
})
const size = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  eventId: 'toolu_1',
  sessionId: 's1',
  kind: 'skill',
  ts: '2026-10-30T10:00:02.000Z',
  sizeChars: 1234,
  ...over,
})

describePg('usage.session_events writer', () => {
  const db = migratedDb()
  let sql: SQL
  beforeEach(async () => {
    sql = await db.reset()
  })

  const rows = async () =>
    (await sql`SELECT source, event_id, source_session_id, kind, ts, name, size_chars, detail, ingested_at FROM usage.session_events ORDER BY source, event_id`) as Record<
      string,
      unknown
    >[]

  test('the two halves of a skill merge into one row, whichever arrives first', async () => {
    await upsertSessionEvents(sql, 'claude-code', [call()])
    await upsertSessionEvents(sql, 'claude-code', [size()])
    await upsertSessionEvents(sql, 'claude-code', [size({ eventId: 'toolu_2' })])
    await upsertSessionEvents(sql, 'claude-code', [
      call({ eventId: 'toolu_2', name: 'beta', ts: '2026-10-30T10:00:00.000Z' }),
    ])
    const r = await rows()
    expect(
      r.map((x) => [x.event_id, x.name, x.size_chars, new Date(x.ts as string).toISOString()]),
    ).toEqual([
      ['toolu_1', 'alpha', 1234, '2026-10-30T10:00:00.000Z'],
      ['toolu_2', 'beta', 1234, '2026-10-30T10:00:00.000Z'],
    ])
  })

  test('halves inside one call merge too; a repeated batch is idempotent and ingested_at moves only on real change', async () => {
    const batch = [
      size(),
      call(),
      {
        eventId: 'cb-1',
        sessionId: 's1',
        kind: 'compaction',
        ts: '2026-10-30T10:05:00.000Z',
        detail: { trigger: 'auto', preTokens: 10 },
      } satisfies SessionEvent,
    ]
    expect(await upsertSessionEvents(sql, 'claude-code', batch)).toBe(2)
    const first = await rows()
    expect(first).toHaveLength(2)
    expect(first[1]).toMatchObject({ event_id: 'toolu_1', name: 'alpha', size_chars: 1234 })
    expect(first[0]?.detail).toEqual({ trigger: 'auto', preTokens: 10 })

    // A --full re-scan emits everything again, possibly as separate calls: nothing changes, nothing is written. The first
    // rows get a known earlier ingested_at so the comparison does not depend on clock resolution.
    const old = '2020-01-01T00:00:00.000Z'
    await sql`UPDATE usage.session_events SET ingested_at = ${old}`
    expect(await upsertSessionEvents(sql, 'claude-code', batch)).toBe(0)
    expect(await upsertSessionEvents(sql, 'claude-code', [call()])).toBe(0)
    expect(await upsertSessionEvents(sql, 'claude-code', [size()])).toBe(0)
    const again = await rows()
    expect(again).toHaveLength(2)
    expect(again.map((x) => new Date(x.ingested_at as string).toISOString())).toEqual([old, old])

    // A real change (a size that was missing) moves ingested_at of that row only.
    await upsertSessionEvents(sql, 'claude-code', [call({ eventId: 'toolu_3', name: 'gamma' })])
    await sql`UPDATE usage.session_events SET ingested_at = ${old}`
    expect(await upsertSessionEvents(sql, 'claude-code', [size({ eventId: 'toolu_3' })])).toBe(1)
    const after = (await rows()).find((x) => x.event_id === 'toolu_3')
    expect(new Date(after?.ingested_at as string).getTime()).toBeGreaterThan(
      new Date(old).getTime(),
    )
    expect(
      (await rows()).filter((x) => new Date(x.ingested_at as string).toISOString() === old),
    ).toHaveLength(2)
    expect(after).toMatchObject({ name: 'gamma', size_chars: 1234 })
  })

  test('a subagent event is keyed <session>:<agent>; sources do not share event ids; an empty batch writes nothing', async () => {
    await upsertSessionEvents(sql, 'claude-code', [call({ agentId: 'ag1' })])
    await upsertSessionEvents(sql, 'other', [call({ name: 'other-skill' })])
    expect(await upsertSessionEvents(sql, 'claude-code', [])).toBe(0)
    expect((await rows()).map((x) => [x.source, x.source_session_id, x.name])).toEqual([
      ['claude-code', 's1:ag1', 'alpha'],
      ['other', 's1', 'other-skill'],
    ])
  })
})
