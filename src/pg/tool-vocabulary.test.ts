import { beforeEach, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { migratedDb } from './fixture.ts'
import { describePg } from './testing.ts'

// Migration 0021: usage.tool_of and the `tool` column of usage.records_unique (docs/usage-schema.md §Tool vocabulary).

const pg = migratedDb()
let db: SQL

beforeEach(async () => {
  db = await pg.reset()
})

const T = '2026-10-30T10:00:00Z'

type Case = [source: string, lane: string, detail: object | null, tool: string]

const CASES: Case[] = [
  ['claude-code', 'interactive', null, 'interactive'],
  ['claude-code', 'lead', null, 'lead'],
  ['claude-code', 'wave_mother', null, 'lead'],
  ['claude-code', 'worker', { role: 'reviewer' }, 'reviewer'],
  ['claude-code', 'worker', { role: 'deep' }, 'deep'],
  ['claude-code', 'worker', { role: 'builder' }, 'worker'],
  ['claude-code', 'worker', null, 'worker'],
  ['claude-code', 'fan_worker', { role: 'reviewer' }, 'reviewer'],
  ['claude-code', 'fan_worker', null, 'worker'],
  ['claude-code', 'subagent', { subagent_type: 'Explore' }, 'Explore'],
  ['claude-code', 'subagent', { subagent_type: 'unknown' }, 'subagent'],
  ['claude-code', 'subagent', { subagent_type: '' }, 'subagent'],
  ['claude-code', 'subagent', null, 'subagent'],
  ['hermes', 'hermes', null, 'hermes'],
  ['gateway', 'iris', null, 'iris'],
  // agw_workflow
  ['gateway', 'agw_workflow', null, 'agw'],
  ['gateway', 'agw_workflow', { workflow: '' }, 'agw'],
  ['gateway', 'agw_workflow', { caller: 'iris' }, 'iris'],
  ['gateway', 'agw_workflow', { workflow: '', caller: '' }, 'agw'],
  ['gateway', 'agw_workflow', { workflow: 'review', step: 'angle:senior-dev' }, 'review'],
  ['gateway', 'agw_workflow', { workflow: 'review_ocr' }, 'review'],
  ['gateway', 'agw_workflow', { workflow: 'verify' }, 'review'],
  ['gateway', 'agw_workflow', { workflow: 'research' }, 'research'],
  [
    'research-gateway',
    'agw_workflow',
    { workflow: 'research-gateway', step: 'worker' },
    'research',
  ],
  ['gateway', 'agw_workflow', { workflow: 'podcast' }, 'podcast'],
  ['gateway', 'agw_workflow', { workflow: 'podcast.produce.unit' }, 'podcast'],
  ['audio-gateway', 'agw_workflow', { workflow: 'audio-gateway', step: 'podcast-tts' }, 'podcast'],
  ['audio-gateway-vps', 'agw_workflow', { workflow: 'audio-gateway-vps', step: 'tts' }, 'audio'],
  ['audio-proxy', 'agw_workflow', { workflow: 'audio-proxy' }, 'audio'],
  ['gateway', 'agw_workflow', { workflow: 'door.speech' }, 'audio'],
  ['gateway', 'agw_workflow', { workflow: 'door.transcriptions' }, 'audio'],
  ['gateway', 'agw_workflow', { workflow: 'ab' }, 'eval'],
  ['gateway', 'agw_workflow', { workflow: 'ab-judge' }, 'eval'],
  ['gateway', 'agw_workflow', { workflow: 'bench' }, 'eval'],
  ['gateway', 'agw_workflow', { workflow: 'eval.mine' }, 'eval'],
  ['gateway', 'agw_workflow', { workflow: 'cap.eval.judge' }, 'eval'],
  ['gateway', 'agw_workflow', { workflow: 'narrative' }, 'narrative'],
  ['gateway', 'agw_workflow', { workflow: 'narrative-polish' }, 'narrative'],
  ['gateway', 'agw_workflow', { workflow: 'overview' }, 'narrative'],
  ['litellm', 'agw_workflow', { workflow: 'litellm' }, 'agw'],
  ['agent-gateway-opencode', 'agw_workflow', { workflow: 'agent-gateway-opencode' }, 'agw'],
  ['gateway', 'agw_workflow', { workflow: 'cap.web.read' }, 'cap'],
  ['gateway', 'agw_workflow', { workflow: 'otel' }, 'otel'],
  // other
  ['athena-teamchat', 'other', null, 'teamchat'],
  ['claude-code', 'other', null, 'headless'],
  ['audio-gateway-mini', 'other', null, 'audio'],
  ['image-gen-gateway', 'other', null, 'image'],
  ['image-gateway', 'other', null, 'image'],
  ['feuer', 'other', null, 'feuer'],
]

describePg('usage.tool_of', () => {
  test('every rule of the vocabulary', async () => {
    for (const [source, lane, detail, want] of CASES) {
      const [row] = await db`
        SELECT usage.tool_of(${source}, ${lane}, ${detail ? JSON.stringify(detail) : null}::text::jsonb) AS tool`
      expect({ source, lane, detail, tool: row.tool }).toEqual({ source, lane, detail, tool: want })
    }
  })

  test('records_unique carries the tool, lane_detail stays verbatim, the other columns are unchanged', async () => {
    await db`
      INSERT INTO usage.records (source, source_id, grain, ts, billing, lane, lane_detail, cost_usd, cost_source)
      VALUES ('gateway', 'a', 'message', ${T}::timestamptz, 'max', 'agw_workflow',
              ${JSON.stringify({ workflow: 'review', step: 'angle:senior-dev' })}::text::jsonb, 2, 'reported')`
    const [row] =
      await db`SELECT tool, lane, lane_detail->>'step' AS step, cost_usd::float8 AS cost FROM usage.records_unique`
    expect(row).toEqual({ tool: 'review', lane: 'agw_workflow', step: 'angle:senior-dev', cost: 2 })
    const cols = await db`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'usage' AND table_name = 'records_unique' ORDER BY ordinal_position DESC LIMIT 1`
    expect(cols[0].column_name).toBe('tool')
  })

  test('no value contains a colon and every lane maps', async () => {
    for (const [source, lane, detail] of CASES) {
      const [row] = await db`
        SELECT usage.tool_of(${source}, ${lane}, ${detail ? JSON.stringify(detail) : null}::text::jsonb) AS tool`
      expect(row.tool).not.toContain(':')
    }
  })
})
