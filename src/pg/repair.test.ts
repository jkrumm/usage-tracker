import type { SQL } from 'bun'
import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from './fixture.ts'
import { repairAttribution } from './repair.ts'
import { describePg } from './testing.ts'

const pg = migratedDb()
let db: SQL

beforeEach(async () => {
  db = await pg.reset()
})

const KNOWN = new Set([
  'argo',
  'dotfiles',
  'software-factory',
  'agent-workflows',
  'hermes-agent',
  'iris',
])
const T = '2026-10-30T10:00:00Z'
const NOW = new Date('2026-10-31T00:00:00Z')
const noEvidence = { evidence: { roots: [], gitRepos: [] } }
const run = (o: { dryRun?: boolean; full?: boolean } = {}) =>
  repairAttribution(db, { full: true, known: KNOWN, now: NOW, ...noEvidence, ...o })

interface R {
  id: string
  source?: string
  project?: string | null
  workspace?: string | null
  repo?: string | null
  detail?: object | null
  modelRaw?: string | null
  model?: string | null
  session?: number | null
  ts?: string
  cost?: number | null
}

async function put(r: R): Promise<number> {
  const [row] = await db`
    INSERT INTO usage.records (source, source_id, grain, ts, session_id, model_raw, model, repo, project_raw, workspace,
                               billing, lane, lane_detail, input_tokens, cost_usd, cost_source)
    VALUES (${r.source ?? 'claude-code'}, ${r.id}, 'message', ${r.ts ?? T}::timestamptz, ${r.session ?? null}, ${r.modelRaw ?? null},
            ${r.model ?? null}, ${r.repo ?? null}, ${r.project ?? null}, ${r.workspace ?? null}, 'max', 'interactive',
            ${r.detail ? JSON.stringify(r.detail) : null}::text::jsonb, 100, ${r.cost ?? 1.5}, 'reported')
    RETURNING id::int AS id`
  return row.id
}

async function putSession(
  key: string,
  o: {
    repo?: string | null
    parent?: number | null
    lane?: string
    detail?: object | null
    first?: string
  } = {},
): Promise<number> {
  const [row] = await db`
    INSERT INTO usage.sessions (source, source_session_id, lane, lane_detail, repo, parent_session_id, billing, first_ts, last_ts)
    VALUES ('claude-code', ${key}, ${o.lane ?? 'interactive'}, ${o.detail ? JSON.stringify(o.detail) : null}::text::jsonb,
            ${o.repo ?? null}, ${o.parent ?? null}, 'max', ${o.first ?? T}::timestamptz, ${o.first ?? T}::timestamptz)
    RETURNING id::int AS id`
  return row.id
}

const rec = async (id: string, source = 'claude-code') =>
  (
    await db`SELECT repo, workspace, model, issue_id, cost_usd::float8 AS cost, cost_source, price_id, ingested_at
            FROM usage.records WHERE source = ${source} AND source_id = ${id}`
  )[0]

describePg('repairAttribution', () => {
  test('classifies bare slugs, renames and folds, and keeps what no rule decides', async () => {
    await put({ id: 'slug', source: 'gateway', project: 'argo', workspace: 'private' })
    await put({ id: 'work', source: 'gateway', project: 'prometheus-epx', workspace: 'work' })
    await put({
      id: 'old',
      project: '/Users/x/IuRoot/prometheus-scripts/analysis',
      repo: 'iu/prometheus-scripts',
    })
    await put({ id: 'fold', project: '/Users/x/SourceRoot/ShutterflowOps', repo: 'ShutterflowOps' })
    await put({ id: 'wt', project: '/Users/x/SourceRoot/worktrees/argo/factory-141-1' })
    await put({ id: 'kept', project: '/private/tmp/x', repo: 'argo' })
    await put({ id: 'owner', source: 'hermes', project: null })
    await put({
      id: 'caller',
      source: 'gateway',
      detail: { caller: 'iris', origin: 'claude-code' },
    })
    await put({ id: 'nothing', source: 'litellm', project: null })

    const res = await run()
    expect(res.repo).toBeGreaterThan(0)

    expect((await rec('slug', 'gateway')).repo).toBe('argo')
    expect((await rec('work', 'gateway')).repo).toBe('iu/epos-ai-teamchat-athena')
    expect((await rec('old')).repo).toBe('iu/epos-tool-athena')
    expect((await rec('fold')).repo).toBe('shutterflow')
    expect((await rec('wt')).repo).toBe('argo')
    expect((await rec('kept')).repo).toBe('argo')
    expect((await rec('owner', 'hermes')).repo).toBe('hermes-agent')
    expect((await rec('caller', 'gateway')).repo).toBe('iris')
    expect((await rec('nothing', 'litellm')).repo).toBeNull()
  })

  test('workspace is derived only when NULL', async () => {
    await put({ id: 'iu', project: '/Users/x/IuRoot/epos-tool-athena' })
    await put({ id: 'src', project: '/Users/x/SourceRoot/argo' })
    await put({ id: 'slug', source: 'gateway', project: 'argo' })
    await put({ id: 'keep', project: '/Users/x/SourceRoot/argo', workspace: 'work' })
    await put({ id: 'none', source: 'litellm' })
    const res = await run()
    expect(res.workspace).toBe(3)
    expect((await rec('iu')).workspace).toBe('work')
    expect((await rec('src')).workspace).toBe('private')
    expect((await rec('slug', 'gateway')).workspace).toBe('private')
    expect((await rec('keep')).workspace).toBe('work')
    expect((await rec('none', 'litellm')).workspace).toBeNull()
  })

  test('models: gateway prefixes are stripped, a gateway-resolved alias is kept, model_raw stays verbatim', async () => {
    await put({
      id: 'a',
      source: 'gateway',
      modelRaw: 'eu.anthropic.claude-haiku-5-5',
      model: 'eu.anthropic.claude-haiku-5-5',
    })
    await put({
      id: 'b',
      source: 'gateway',
      modelRaw: 'deepseek-v4.1-flash',
      model: 'deepseek/deepseek-v4.1-flash',
    })
    await put({ id: 'c', source: 'gateway', modelRaw: 'haiku', model: 'claude-haiku-5-5' })
    await put({ id: 'd', source: 'gateway', modelRaw: 'openai.gpt-6.1-terra', model: null })
    await put({ id: 'e', source: 'gateway', modelRaw: null, model: null })
    const res = await run()
    expect(res.model).toBe(3)
    expect((await rec('a', 'gateway')).model).toBe('claude-haiku-5-5')
    expect((await rec('b', 'gateway')).model).toBe('deepseek-v4.1-flash')
    expect((await rec('c', 'gateway')).model).toBe('claude-haiku-5-5')
    expect((await rec('d', 'gateway')).model).toBe('gpt-6.1-terra')
    expect((await rec('e', 'gateway')).model).toBeNull()
    const [raw] = await db`SELECT model_raw FROM usage.records WHERE source_id = 'a'`
    expect(raw.model_raw).toBe('eu.anthropic.claude-haiku-5-5')
  })

  test('issue ids: factory worktree paths, lead sessions, subagents inherit from the parent', async () => {
    const lead = await putSession('lead-sess')
    const sub = await putSession('lead-sess:agent1', { parent: lead, lane: 'subagent' })
    const wt = await putSession('wt-sess')
    await db`INSERT INTO usage.session_env (session, factory_session, seen_at) VALUES ('lead-sess', 'lead-141-2', now())`
    await put({ id: 'lead', session: lead, project: '/Users/x/SourceRoot/argo' })
    await put({ id: 'sub', session: sub, project: '/Users/x/SourceRoot/argo' })
    await put({ id: 'wt', session: wt, project: '/Users/x/SourceRoot/worktrees/argo/factory-77-1' })
    const res = await run()
    expect(res.issue).toBeGreaterThanOrEqual(6)
    expect((await rec('lead')).issue_id).toBe('141')
    expect((await rec('sub')).issue_id).toBe('141')
    expect((await rec('wt')).issue_id).toBe('77')
    const sessions =
      await db`SELECT source_session_id AS k, issue_id FROM usage.sessions ORDER BY 1`
    expect(
      Object.fromEntries(sessions.map((s: { k: string; issue_id: string }) => [s.k, s.issue_id])),
    ).toEqual({
      'lead-sess': '141',
      'lead-sess:agent1': '141',
      'wt-sess': '77',
    })
  })

  test('an existing issue_id is never overwritten', async () => {
    const lead = await putSession('lead-sess')
    await db`INSERT INTO usage.session_env (session, factory_session, seen_at) VALUES ('lead-sess', 'lead-141-1', now())`
    await db`UPDATE usage.sessions SET issue_id = 'own'`
    await put({ id: 'x', session: lead })
    await db`UPDATE usage.records SET issue_id = 'mine'`
    await run()
    expect((await rec('x')).issue_id).toBe('mine')
    expect((await db`SELECT issue_id FROM usage.sessions`)[0].issue_id).toBe('own')
  })

  test('sessions are renamed and filled from their records', async () => {
    const renamed = await putSession('s1', { repo: 'iu/prometheus-epx' })
    const filled = await putSession('s2')
    await put({ id: 'r', session: filled, project: '/Users/x/SourceRoot/dotfiles' })
    await put({ id: 'r1', session: renamed, project: '/Users/x/IuRoot/prometheus-epx' })
    const res = await run()
    expect(res.repo).toBeGreaterThanOrEqual(4)
    const rows = await db`SELECT source_session_id AS k, repo FROM usage.sessions ORDER BY 1`
    expect(rows.map((r: { k: string; repo: string }) => [r.k, r.repo])).toEqual([
      ['s1', 'iu/epos-ai-teamchat-athena'],
      ['s2', 'dotfiles'],
    ])
  })

  test('idempotent: the second run changes nothing and does not move ingested_at; costs never change', async () => {
    await put({
      id: 'a',
      source: 'gateway',
      project: 'argo',
      modelRaw: 'openai.gpt-6.1-terra',
      model: 'openai.gpt-6.1-terra',
    })
    await put({ id: 'b', project: '/Users/x/IuRoot/prometheus-scripts' })
    await put({ id: 'c', source: 'hermes' })
    const costs = async () =>
      db`SELECT source_id, cost_usd::float8 AS c, cost_source, price_id, cost_reported_usd FROM usage.records ORDER BY id`
    const before = await costs()
    const first = await run()
    expect(first.repo + first.workspace + first.model).toBeGreaterThan(0)
    const stamp = await db`SELECT source_id, ingested_at FROM usage.records ORDER BY id`
    expect(await costs()).toEqual(before)

    const second = await run()
    expect(second).toMatchObject({ repo: 0, workspace: 0, model: 0, issue: 0, duplicates: 0 })
    expect(await db`SELECT source_id, ingested_at FROM usage.records ORDER BY id`).toEqual(stamp)
    expect(await costs()).toEqual(before)
  })

  test('changed rows get a new ingested_at, untouched rows keep theirs', async () => {
    await put({ id: 'changed', source: 'gateway', project: 'argo' })
    await put({ id: 'same', source: 'litellm' })
    await db`UPDATE usage.records SET ingested_at = '2026-01-01T00:00:00Z'`
    await run()
    expect((await rec('changed', 'gateway')).ingested_at.toISOString()).toBe(NOW.toISOString())
    expect((await rec('same', 'litellm')).ingested_at.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    )
  })

  test('an ongoing pass looks only at the recent window, full at everything', async () => {
    await put({ id: 'old', source: 'gateway', project: 'argo', ts: '2026-09-01T00:00:00Z' })
    await put({ id: 'new', source: 'gateway', project: 'argo', ts: '2026-10-30T00:00:00Z' })
    await repairAttribution(db, { known: KNOWN, now: NOW, ...noEvidence })
    expect((await rec('new', 'gateway')).repo).toBe('argo')
    expect((await rec('old', 'gateway')).repo).toBeNull()
    await run()
    expect((await rec('old', 'gateway')).repo).toBe('argo')
  })

  test('dry run writes nothing and reports the repo moves with their cost', async () => {
    await put({ id: 'a', source: 'gateway', project: 'argo', cost: 2 })
    await put({ id: 'b', source: 'gateway', project: 'argo', cost: 3 })
    const dry = await run({ dryRun: true })
    expect(dry.repo).toBe(2)
    expect((await rec('a', 'gateway')).repo).toBeNull()
    expect(dry.byRepo).toEqual(
      expect.arrayContaining([
        { repo: 'argo', rows: { before: 0, after: 2 }, cost: { before: 0, after: 5 } },
        { repo: '(none)', rows: { before: 2, after: 0 }, cost: { before: 5, after: 0 } },
      ]),
    )
    expect((await db`SELECT count(*)::int AS n FROM usage.session_repo`)[0].n).toBe(0)
    const real = await run()
    expect(real.repo).toBe(dry.repo)
    expect((await rec('a', 'gateway')).repo).toBe('argo')
  })

  test('cutover duplicates are marked by the pass and a second pass marks none', async () => {
    await put({
      id: 'g1',
      source: 'gateway',
      detail: { caller: 'hermes' },
      ts: '2026-11-02T07:00:00Z',
    })
    await put({ id: 'h-old', source: 'hermes', ts: '2026-11-01T07:00:00Z' })
    await put({ id: 'h-new', source: 'hermes', ts: '2026-11-02T08:00:00Z' })
    const res = await run()
    expect(res.duplicates).toBe(1)
    expect((await run()).duplicates).toBe(0)
  })

  test('evidence: a session resolved from its transcript gives its records and session the repo, c/d only fill the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-'))
    const proj = join(root, '-p')
    mkdirSync(proj)
    const tool = (path: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path } }] },
      })
    const lines = Array.from({ length: 4 }, (_, i) => tool(`/Users/x/SourceRoot/dotfiles/f${i}.ts`))
    writeFileSync(join(proj, 'sess-ev.jsonl'), `${lines.join('\n')}\n`)
    const sid = await putSession('sess-ev')
    await put({
      id: 'ev',
      session: sid,
      project: '/Users/x/.local/state/agent-gateway/worktrees/abc',
    })
    await put({ id: 'owner', session: sid, source: 'research-gateway' })
    const res = await repairAttribution(db, {
      full: true,
      known: KNOWN,
      now: NOW,
      evidence: { roots: [root], gitRepos: [] },
    })
    expect(res.evidence).toEqual({ 'transcript-paths': 1 })
    expect((await rec('ev')).repo).toBe('dotfiles')
    expect((await rec('owner', 'research-gateway')).repo).toBe('dotfiles')
    expect((await db`SELECT repo FROM usage.sessions WHERE id = ${sid}`)[0].repo).toBe('dotfiles')
    expect((await rec('ev')).workspace).toBe('private')
  })
  test('gateway rows get one session per lane_detail.session key, idempotently, and the session repo follows the rows', async () => {
    const H = (n: number) => new Date(Date.parse(T) + n * 3_600_000).toISOString()
    await put({
      id: 'g2',
      source: 'gateway',
      ts: H(1),
      project: 'argo',
      workspace: 'private',
      detail: { session: 's1' },
      cost: 2,
    })
    await put({ id: 'g1', source: 'gateway', ts: H(0), detail: { session: 's1' }, cost: 1 })
    await put({ id: 'g3', source: 'gateway', ts: H(2), detail: { session: 's2' }, cost: 4 })
    await put({ id: 'nokey', source: 'gateway', detail: { session: null } })
    await put({ id: 'cc', source: 'claude-code', detail: { session: 's1' } })
    await db`UPDATE usage.records SET lane = 'agw_workflow', billing = 'api_credit', account = 'me'
             WHERE source = 'gateway' AND source_id = 'g1'`
    const costs = async () =>
      (await db`SELECT source_id, cost_usd::float8 AS c FROM usage.records ORDER BY source_id`).map(
        (r: { source_id: string; c: number }) => `${r.source_id}=${r.c}`,
      )
    const before = await costs()

    const dry = await run({ dryRun: true })
    expect(dry.gatewaySessions).toBe(2)
    expect(dry.gatewayRecords).toBe(3)
    expect((await db`SELECT count(*)::int AS n FROM usage.sessions`)[0].n).toBe(0)

    const res = await run()
    expect(res.gatewaySessions).toBe(2)
    expect(res.gatewayRecords).toBe(3)
    const sessions = await db`
      SELECT source, source_session_id AS key, lane, billing, account, repo, first_ts, last_ts
      FROM usage.sessions ORDER BY source_session_id`
    expect(sessions.map((s: { key: string }) => s.key)).toEqual(['s1', 's2'])
    const s1 = sessions[0]
    expect(s1.source).toBe('gateway')
    expect(s1.lane).toBe('agw_workflow') // the earliest row's
    expect(s1.billing).toBe('api_credit')
    expect(s1.account).toBe('me')
    expect(new Date(s1.first_ts).toISOString()).toBe(H(0))
    expect(new Date(s1.last_ts).toISOString()).toBe(H(1))
    expect(s1.repo).toBe('argo') // from g2, set by the repo rules in the same pass
    const linked = await db`SELECT source_id, session_id FROM usage.records ORDER BY source_id`
    const byId = Object.fromEntries(
      linked.map((r: { source_id: string; session_id: number | null }) => [
        r.source_id,
        r.session_id,
      ]),
    )
    expect(byId.g1).toBe(byId.g2)
    expect(byId.g3).not.toBeNull()
    expect(byId.nokey).toBeNull()
    expect(byId.cc).toBeNull()
    expect(await costs()).toEqual(before)

    const again = await run()
    expect(again.gatewaySessions).toBe(0)
    expect(again.gatewayRecords).toBe(0)

    // a later row of a known session only widens the span
    await put({ id: 'g4', source: 'gateway', ts: H(5), detail: { session: 's1' } })
    const widened = await run()
    expect(widened.gatewaySessions).toBe(0)
    expect(widened.gatewayRecords).toBe(1)
    const [after] =
      await db`SELECT last_ts, lane FROM usage.sessions WHERE source_session_id = 's1'`
    expect(new Date(after.last_ts).toISOString()).toBe(H(5))
    expect(after.lane).toBe('agw_workflow')
    expect((await db`SELECT count(*)::int AS n FROM usage.session_repo`)[0].n).toBe(0)
  })
})
