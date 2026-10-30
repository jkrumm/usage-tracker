import { describe, expect, test } from 'bun:test'
import { aggregateSessions, parentSessionKey, sessionKey, type SessionInput } from './sessions.ts'
import { mapBilling } from './writer.ts'

const rec = (sourceId: string, grain: 'message' | 'session', raw?: Record<string, unknown>) => ({
  sourceId,
  grain,
  raw,
})

describe('sessionKey', () => {
  test('raw.sessionId identifies the session of claude-code, codex and opencode messages', () => {
    expect(sessionKey('claude-code', rec('req_1', 'message', { sessionId: 's1' }))).toBe('s1')
    expect(sessionKey('opencode', rec('msg_1', 'message', { sessionId: 'ses_1' }))).toBe('ses_1')
  })

  test("a claude-code subagent is its own session under the parent's id, whose raw.sessionId stays the parent's", () => {
    expect(
      sessionKey('claude-code', rec('req_2', 'message', { sessionId: 's1', agentId: 'a9' })),
    ).toBe('s1:a9')
    expect(
      parentSessionKey({ raw: { sessionId: 's1', agentId: 'a9', parentSessionId: 's1' } }),
    ).toBe('s1')
    // no parent session id, no session: none is invented from the agent id
    expect(sessionKey('claude-code', rec('req_3', 'message', { agentId: 'a9' }))).toBeNull()
  })

  test('agent-workflows rows are sessions per run', () => {
    expect(
      sessionKey('agent-workflows', rec('c1', 'message', { runId: 'run-9', sessionId: 's1' })),
    ).toBe('run-9')
    expect(sessionKey('agent-workflows', rec('c1', 'message', { sessionId: 's1' }))).toBe('s1')
    expect(sessionKey('agent-workflows', rec('c1', 'message'))).toBeNull()
  })

  test('hermes and feuer composite source ids carry the session id first', () => {
    expect(sessionKey('hermes', rec('20261001_abc:main:gpt-5.6-luna', 'session'))).toBe(
      '20261001_abc',
    )
    expect(sessionKey('feuer', rec('legacy_session', 'session'))).toBe('legacy_session')
  })

  test('a session-grain row is its own session, a message without a session id has none', () => {
    expect(sessionKey('opencode', rec('ses_2', 'session', { slug: 'x' }))).toBe('ses_2')
    expect(sessionKey('modelpick', rec('42', 'session'))).toBe('42')
    expect(sessionKey('litellm', rec('req', 'message'))).toBeNull()
    expect(sessionKey('astra', rec('req', 'message', { effort: 'high' }))).toBeNull()
    expect(sessionKey('codex', rec('resp', 'message', { sessionId: null }))).toBeNull()
  })
})

test('parentSessionKey reads raw.parentSessionId only', () => {
  expect(parentSessionKey({ raw: { parentSessionId: 'p' } })).toBe('p')
  expect(parentSessionKey({ raw: { parentUuid: 'p' } })).toBeNull()
  expect(parentSessionKey({})).toBeNull()
})

const input = (o: Partial<SessionInput>): SessionInput => ({
  key: 's',
  parentKey: null,
  ts: Date.parse('2026-10-30T10:00:00Z'),
  lane: 'interactive',
  laneDetail: null,
  billing: 'max',
  account: 'iu',
  apiKey: null,
  machine: 'mini',
  model: 'claude-sonnet-5',
  effort: null,
  repo: 'argo',
  issueId: null,
  runId: null,
  ...o,
})

describe('aggregateSessions', () => {
  test('spans first and last record, one row per session', () => {
    const rows = aggregateSessions([
      input({ key: 'b', ts: Date.parse('2026-10-30T10:05:00Z') }),
      input({ key: 'a', ts: Date.parse('2026-10-30T10:09:00Z') }),
      input({ key: 'b', ts: Date.parse('2026-10-30T10:00:00Z') }),
    ])
    expect(rows.map((r) => r.source_session_id)).toEqual(['a', 'b'])
    expect(rows[1]).toMatchObject({
      first_ts: '2026-10-30T10:00:00.000Z',
      last_ts: '2026-10-30T10:05:00.000Z',
    })
  })

  test('a subagent record inside an interactive session keeps the session interactive', () => {
    const [row] = aggregateSessions([
      input({ ts: 1000, lane: 'subagent', laneDetail: { subagent_type: 'Explore' } }),
      input({ ts: 2000, lane: 'interactive' }),
    ])
    expect(row).toMatchObject({ lane: 'interactive', lane_detail: null })
  })

  test('a session seen through subagent records alone is subagent', () => {
    const [row] = aggregateSessions([
      input({ lane: 'subagent', laneDetail: { subagent_type: 'Explore' } }),
    ])
    expect(row?.lane).toBe('subagent')
  })

  test('attributes come from the first record that has them, NULL never erases', () => {
    const [row] = aggregateSessions([
      input({
        ts: 1000,
        account: null,
        effort: null,
        issueId: null,
        billing: 'unknown',
        repo: null,
      }),
      input({
        ts: 2000,
        account: 'me',
        effort: 'high',
        issueId: 'FOO-1',
        billing: 'max',
        repo: 'argo',
        runId: 'r1',
      }),
      input({ ts: 3000, account: 'iu', effort: 'low', repo: 'other' }),
    ])
    expect(row).toMatchObject({
      account: 'me',
      effort: 'high',
      issue_id: 'FOO-1',
      billing: 'max',
      repo: 'argo',
      run_id: 'r1',
    })
  })

  test('a parent link is taken from any record and never points at the session itself', () => {
    const [self] = aggregateSessions([input({ key: 's', parentKey: 's' })])
    expect(self?.parent_key).toBeNull()
    const [child] = aggregateSessions([input({ key: 'c' }), input({ key: 'c', parentKey: 'p' })])
    expect(child?.parent_key).toBe('p')
  })
})

describe('writer constants', () => {
  test('billing maps to who pays', () => {
    expect(mapBilling('max')).toBe('max')
    expect(mapBilling('iu')).toBe('api_key')
    expect(mapBilling('anthropic-api')).toBe('api_key')
    expect(mapBilling('unknown')).toBe('unknown')
  })
})

describe('aggregateSessions subagent detail', () => {
  const input = (ts: number, type: string): SessionInput => ({
    key: 's:a',
    parentKey: 's',
    ts,
    lane: 'subagent',
    laneDetail: { subagent_type: type },
    billing: 'max',
    account: null,
    apiKey: null,
    machine: null,
    model: null,
    effort: null,
    repo: null,
    issueId: null,
    runId: null,
  })
  test('an unknown type is replaced by the first known one in the batch', () => {
    expect(aggregateSessions([input(1, 'unknown'), input(2, 'Explore')])[0]?.lane_detail).toEqual({
      subagent_type: 'Explore',
    })
    expect(aggregateSessions([input(1, 'unknown')])[0]?.lane_detail).toEqual({
      subagent_type: 'unknown',
    })
  })
})
