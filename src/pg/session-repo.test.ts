import type { SQL } from 'bun'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDb } from './fixture.ts'
import {
  diffSha,
  firstPrompt,
  indexTranscripts,
  pathsRepo,
  resolveSessionRepos,
  saveSessionRepos,
} from './session-repo.ts'
import { describePg } from './testing.ts'

const line = (o: object) => JSON.stringify(o)
const toolUse = (input: object) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input }] } })
const SRC = '/Users/x/SourceRoot'

describe('transcript evidence (pure)', () => {
  test('the first prompt is the first queued or user text', () => {
    const head = [
      line({ type: 'summary' }),
      line({ type: 'queue-operation', operation: 'enqueue', content: 'review this' }),
      line({ type: 'user', message: { content: 'later' } }),
    ].join('\n')
    expect(firstPrompt(head)).toBe('review this')
    expect(
      firstPrompt(line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })),
    ).toBe('hi')
    expect(firstPrompt('not json\n')).toBeNull()
  })

  test('diffSha finds the commit of a review prompt, with or without flags', () => {
    const sha = 'e161e81fd6bf377fad2023fc49b84d16286a1f29'
    expect(diffSha(`Run: \`git diff --no-renames ${sha}...HEAD\``)).toBe(sha)
    expect(diffSha(`git diff ${sha.slice(0, 9)}...HEAD`)).toBe(sha.slice(0, 9))
    expect(diffSha('git diff main...HEAD')).toBeNull()
    expect(diffSha('no diff here')).toBeNull()
  })

  test('paths: a winner needs 60% of the classified hits and at least 3', () => {
    const t = (paths: string[]) => paths.map((p) => toolUse({ file_path: p })).join('\n')
    expect(pathsRepo(t([`${SRC}/argo/a`, `${SRC}/argo/b`, `${SRC}/argo/c`]))).toBe('argo')
    expect(pathsRepo(t([`${SRC}/argo/a`, `${SRC}/argo/b`]))).toBeNull()
    expect(
      pathsRepo(
        t([
          `${SRC}/argo/a`,
          `${SRC}/argo/b`,
          `${SRC}/argo/c`,
          `${SRC}/dotfiles/x`,
          `${SRC}/brain/y`,
        ]),
      ),
    ).toBe('argo')
    expect(
      pathsRepo(
        t([
          `${SRC}/argo/a`,
          `${SRC}/argo/b`,
          `${SRC}/argo/c`,
          `${SRC}/dotfiles/x`,
          `${SRC}/brain/y`,
          `${SRC}/brain/z`,
        ]),
      ),
    ).toBeNull()
  })

  test('paths: commands count, renames apply, unclassifiable paths do not dilute', () => {
    const lines = [
      toolUse({ command: 'cd /Users/x/IuRoot/prometheus-scripts && ls' }),
      toolUse({ path: '/Users/x/IuRoot/prometheus-scripts/a' }),
      toolUse({ file_path: '/Users/x/IuRoot/prometheus-scripts/b' }),
      toolUse({ file_path: '/Users/x/IuRoot/worktrees/split-w1/b' }),
      toolUse({ file_path: '/tmp/x' }),
    ].join('\n')
    expect(pathsRepo(lines)).toBe('iu/epos-tool-athena')
  })
})

describePg('session repo evidence (Postgres)', () => {
  const pg = migratedDb()
  let db: SQL
  let root: string
  let proj: string
  beforeEach(async () => {
    db = await pg.reset()
    root = mkdtempSync(join(tmpdir(), 'sess-repo-'))
    proj = join(root, '-p')
    mkdirSync(proj)
  })

  const session = async (
    key: string,
    o: { repo?: string; parent?: number; detail?: object; first?: string; last?: string } = {},
  ): Promise<number> => {
    const first = o.first ?? '2026-10-30T10:00:00Z'
    const [row] = await db`
      INSERT INTO usage.sessions (source, source_session_id, lane, lane_detail, repo, parent_session_id, billing, first_ts, last_ts)
      VALUES ('claude-code', ${key}, ${o.detail ? 'agw_workflow' : 'interactive'},
              ${o.detail ? JSON.stringify(o.detail) : null}::text::jsonb, ${o.repo ?? null}, ${o.parent ?? null}, 'max',
              ${first}::timestamptz, ${o.last ?? first}::timestamptz)
      RETURNING id::int AS id`
    return row.id
  }
  const transcript = (name: string, lines: string[]) =>
    writeFileSync(join(proj, `${name}.jsonl`), `${lines.join('\n')}\n`)
  const opts = (extra = {}) => ({ roots: [root], gitRepos: [], ...extra })
  const verdicts = async (o = opts()) =>
    Object.fromEntries(
      (await resolveSessionRepos(db, o)).map((r) => [r.sessionId, `${r.evidence}:${r.repo}`]),
    )

  test('indexTranscripts keys main files by id and subagent files by <parent>:<agent>', async () => {
    transcript('main-1', [line({ type: 'user' })])
    mkdirSync(join(proj, 'main-1', 'subagents', 'workflows'), { recursive: true })
    writeFileSync(join(proj, 'main-1', 'subagents', 'agent-a1.jsonl'), '{}\n')
    writeFileSync(join(proj, 'main-1', 'subagents', 'workflows', 'agent-a2.jsonl'), '{}\n')
    const index = await indexTranscripts([root])
    expect([...index.keys()].sort()).toEqual(['main-1', 'main-1:a1', 'main-1:a2'])
  })

  test('git-sha: the repo of the checkout that has the commit, a commit nobody has falls through', async () => {
    const repoDir = join(root, 'checkout')
    mkdirSync(repoDir)
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-C', repoDir, ...args], { stdout: 'pipe', stderr: 'pipe' })
    git('init', '-q')
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    )
    const sha = git('rev-parse', 'HEAD').stdout.toString().trim()
    transcript('review-1', [
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: `Run: git diff --no-renames ${sha}...HEAD`,
      }),
    ])
    transcript('review-2', [
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'git diff 0123456789abcdef...HEAD',
      }),
    ])
    const a = await session('review-1')
    const b = await session('review-2')
    const got = await verdicts(opts({ gitRepos: [{ dir: repoDir, repo: 'argo' }] }))
    expect(got[a]).toBe('git-sha:argo')
    expect(got[b]).toBe('none:null')
  })

  test('transcript-paths, then parent, then neighbor; none when a scanned transcript says nothing', async () => {
    transcript(
      'paths',
      [1, 2, 3].map((i) => toolUse({ file_path: `${SRC}/dotfiles/f${i}` })),
    )
    transcript('quiet', [line({ type: 'user', message: { content: 'hello' } })])
    transcript('child', [line({ type: 'user', message: { content: 'hello' } })])
    transcript('syn', [line({ type: 'user', message: { content: 'synthesis' } })])
    const paths = await session('paths')
    const parent = await session('parent-known', { repo: 'brain' })
    const child = await session('child', { parent })
    const quiet = await session('quiet')
    const wf = { workflow: 'review' }
    const angle = await session('angle', {
      detail: wf,
      first: '2026-10-30T12:00:00Z',
      repo: 'argo',
    })
    const syn = await session('syn', { detail: wf, first: '2026-10-30T12:10:00Z' })
    const far = await session('far', { detail: wf, first: '2026-10-30T15:00:00Z' })
    transcript('far', [line({ type: 'user', message: { content: 'x' } })])
    const got = await verdicts()
    expect(got[paths]).toBe('transcript-paths:dotfiles')
    expect(got[child]).toBe('parent:brain')
    expect(got[quiet]).toBe('none:null')
    expect(got[syn]).toBe('neighbor:argo')
    expect(got[far]).toBe('none:null')
    expect(got[angle]).toBeUndefined()
  })

  test('neighbors that disagree decide nothing; a session without a transcript is not scanned', async () => {
    const wf = { workflow: 'review' }
    await session('n1', { detail: wf, first: '2026-10-30T12:00:00Z', repo: 'argo' })
    await session('n2', { detail: wf, first: '2026-10-30T12:05:00Z', repo: 'dotfiles' })
    transcript('lone', [line({ type: 'user', message: { content: 'x' } })])
    const lone = await session('lone', { detail: wf, first: '2026-10-30T12:07:00Z' })
    const missing = await session('missing')
    const got = await verdicts()
    expect(got[lone]).toBe('none:null')
    expect(got[missing]).toBeUndefined()
  })

  test('only sessions without a verdict are scanned; sinceDays and limit bound the pass; save is idempotent', async () => {
    transcript(
      's-old',
      [1, 2, 3].map((i) => toolUse({ file_path: `${SRC}/argo/${i}` })),
    )
    transcript(
      's-new',
      [1, 2, 3].map((i) => toolUse({ file_path: `${SRC}/argo/${i}` })),
    )
    const old = await session('s-old', { first: '2020-01-01T00:00:00Z' })
    const recent = await session('s-new', { first: new Date().toISOString() })

    expect(Object.keys(await verdicts(opts({ sinceDays: 3 })))).toEqual([String(recent)])
    expect(Object.keys(await verdicts(opts({ limit: 1 }))).length).toBe(1)

    await saveSessionRepos(db, await resolveSessionRepos(db, opts()))
    await saveSessionRepos(db, await resolveSessionRepos(db, opts()))
    expect(await resolveSessionRepos(db, opts())).toEqual([])
    const rows =
      await db`SELECT session_id::int AS id, repo, evidence FROM usage.session_repo ORDER BY id`
    expect(rows.map((r: { id: number; evidence: string }) => [r.id, r.evidence])).toEqual(
      [old, recent].sort((a, b) => a - b).map((id) => [id, 'transcript-paths']),
    )
  })

  test('a none is rescanned once the session has grown, a found repo is final', async () => {
    transcript('live', [line({ type: 'user', message: { content: 'hello' } })])
    const live = await session('live')
    await saveSessionRepos(db, await resolveSessionRepos(db, opts()))
    expect((await verdicts())[live]).toBeUndefined()

    transcript(
      'live',
      [1, 2, 3].map((i) => toolUse({ file_path: `${SRC}/dotfiles/f${i}` })),
    )
    await db`UPDATE usage.sessions SET last_ts = now() + interval '1 minute' WHERE id = ${live}`
    await saveSessionRepos(db, await resolveSessionRepos(db, opts()))
    const [row] = await db`SELECT repo, evidence FROM usage.session_repo WHERE session_id = ${live}`
    expect(row).toMatchObject({ repo: 'dotfiles', evidence: 'transcript-paths' })
    expect((await verdicts())[live]).toBeUndefined()
  })

  test('the table refuses a verdict that contradicts itself', async () => {
    const id = await session('x')
    await expect(
      db`INSERT INTO usage.session_repo (session_id, repo, evidence) VALUES (${id}, 'argo', 'none')`,
    ).rejects.toThrow()
    await expect(
      db`INSERT INTO usage.session_repo (session_id, repo, evidence) VALUES (${id}, NULL, 'git-sha')`,
    ).rejects.toThrow()
  })
})
