import type { SQL } from 'bun'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeRoots } from '../collectors/claude-code.ts'
import { walkJsonlFiles } from '../collectors/fs-incremental.ts'
import { classifyRepo, renameRepo } from '../repo.ts'
import { payload } from './writer.ts'

// Session repo evidence (usage.session_repo, migration 0016). A claude-code session whose cwd names no repo (a deleted UUID
// worktree under ~/.local/state/{agent-gateway,sideclaw}/worktrees, the bare home or SourceRoot) is resolved from its
// transcript, first hit wins:
//   git-sha            the first prompt diffs against a commit (`git diff [--flags] <sha>...HEAD`, the review angles); the
//                      repo is the checkout that has the commit
//   transcript-paths   the paths its tool calls touched: a repo with >= 60% of the classified hits and at least 3
//   parent             the parent session's repo
//   neighbor           sessions of the same workflow starting within 15 minutes, resolved, all agreeing (review synthesis
//                      prompts carry no sha)
//   none               scanned, nothing found: stored with a NULL repo so it is not scanned again
// Reading only: `resolveSessionRepos` returns the verdicts, `saveSessionRepos` writes them. The repair pass applies them.

/** What the queries need: a connection or a transaction. */
export type Db = Pick<SQL, 'unsafe'>

export type Evidence = 'git-sha' | 'transcript-paths' | 'parent' | 'neighbor' | 'none'

export interface SessionRepoResult {
  sessionId: number
  repo: string | null
  evidence: Evidence
}

export interface GitRepo {
  /** A checkout directory. */
  dir: string
  /** The repo name its commits belong to (already renamed). */
  repo: string
}

export interface SessionRepoOptions {
  /** Only sessions active in the last N days; undefined scans every session without a verdict. */
  sinceDays?: number
  limit?: number
  /** Transcript roots (default: the claude-code collector's). */
  roots?: string[]
  /** Checkouts searched for a commit (default: SourceRoot, IuRoot, the two archived IU repos). */
  gitRepos?: GitRepo[]
}

const PATH_SHARE = 0.6
const PATH_MIN_HITS = 3
const NEIGHBOR_MS = 15 * 60_000
const PROMPT_BYTES = 512 * 1024
const TRANSCRIPT_BYTES = 32 * 1024 * 1024

const SUBAGENT_FILE = /([^/]+)\/subagents\/(?:[^/]+\/)*agent-([^/]+)\.jsonl$/
const DIFF_SHA = /git diff(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+([0-9a-f]{7,40})\.\.\.HEAD/
const ROOT_PATH = /\/(?:Users|home)\/[^/\s"'`]+\/(?:SourceRoot|IuRoot)\/[^\s"'`;|)\]]*/g

/** Session id (`<id>` or `<parent>:<agentId>`, as usage.sessions keys them) -> transcript file, over every root. */
export async function indexTranscripts(roots: string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const root of roots) {
    for (const file of await walkJsonlFiles(root)) {
      const sub = SUBAGENT_FILE.exec(file)
      if (sub) index.set(`${sub[1]}:${sub[2]}`, file)
      else index.set(file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length), file)
    }
  }
  return index
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((b: { type?: string; text?: string }) =>
    b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
  )
  return parts.length > 0 ? parts.join('\n') : null
}

/** The first prompt of a transcript: its first queued or user message text. */
export function firstPrompt(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue
    let obj: {
      type?: string
      operation?: string
      content?: unknown
      message?: { content?: unknown }
    }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const text =
      obj.type === 'queue-operation' && obj.operation === 'enqueue'
        ? textOf(obj.content)
        : obj.type === 'user'
          ? textOf(obj.message?.content)
          : null
    if (text) return text
  }
  return null
}

/** The commit a review prompt diffs against, or null. */
export function diffSha(prompt: string): string | null {
  return DIFF_SHA.exec(prompt)?.[1] ?? null
}

/** The repo a transcript's tool calls point at: the winner needs >= 60% of the classified path hits and >= 3 hits. */
export function pathsRepo(transcript: string): string | null {
  const tally = new Map<string, number>()
  let total = 0
  for (const line of transcript.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let obj: { message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_use' || !block.input) continue
      for (const key of ['file_path', 'path', 'command']) {
        const value = block.input[key]
        if (typeof value !== 'string') continue
        for (const m of value.matchAll(ROOT_PATH)) {
          const repo = classifyRepo({ project: m[0] })
          if (!repo) continue
          tally.set(repo, (tally.get(repo) ?? 0) + 1)
          total++
        }
      }
    }
  }
  const [winner] = [...tally].sort((a, b) => b[1] - a[1])
  if (!winner || winner[1] < PATH_MIN_HITS || winner[1] / total < PATH_SHARE) return null
  return winner[0]
}

/** Checkouts a commit can be searched in: SourceRoot and IuRoot directories that are git checkouts, plus the archived IU repos. */
export function defaultGitRepos(home = homedir()): GitRepo[] {
  const out: GitRepo[] = []
  const add = (root: string, name: (d: string) => string | null): void => {
    if (!existsSync(root)) return
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const dir = join(root, e.name)
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'worktrees') continue
      if (!existsSync(join(dir, '.git'))) continue
      const repo = name(e.name)
      if (repo) out.push({ dir, repo })
    }
  }
  add(join(home, 'SourceRoot'), (d) => classifyRepo({ project: join(home, 'SourceRoot', d) }))
  add(join(home, 'IuRoot'), (d) => renameRepo(`iu/${d}`))
  for (const d of ['prometheus-epx', 'prometheus-scripts']) {
    const dir = join(home, 'IuRoot', '.archive', d)
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'HEAD')))
      out.push({ dir, repo: renameRepo(`iu/${d}`) })
  }
  return out
}

function shaResolver(repos: GitRepo[]): (sha: string) => string | null {
  const cache = new Map<string, string | null>()
  return (sha) => {
    if (cache.has(sha)) return cache.get(sha) ?? null
    let found: string | null = null
    for (const { dir, repo } of repos) {
      const r = Bun.spawnSync(['git', '-C', dir, 'cat-file', '-e', `${sha}^{commit}`], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      if (r.exitCode === 0) {
        found = repo
        break
      }
    }
    cache.set(sha, found)
    return found
  }
}

interface Candidate {
  id: number
  key: string
  parentId: number | null
  workflow: string | null
  firstTs: number
}

async function candidates(sql: Db, opts: SessionRepoOptions): Promise<Candidate[]> {
  const rows = await sql.unsafe(
    `SELECT s.id::int AS id, s.source_session_id AS key, s.parent_session_id::int AS parent_id,
            s.lane_detail->>'workflow' AS workflow, s.first_ts
     FROM usage.sessions s LEFT JOIN usage.session_repo e ON e.session_id = s.id
     WHERE s.source = 'claude-code' AND s.repo IS NULL
       AND (e.session_id IS NULL OR (e.evidence = 'none' AND s.last_ts > e.scanned_at))
       AND ($1::int IS NULL OR s.last_ts >= now() - make_interval(days => $1::int))
     ORDER BY s.last_ts DESC
     LIMIT $2::int`,
    [opts.sinceDays ?? null, opts.limit ?? 1_000_000],
  )
  return rows.map(
    (r: {
      id: number
      key: string
      parent_id: number | null
      workflow: string | null
      first_ts: Date
    }) => ({
      id: r.id,
      key: r.key,
      parentId: r.parent_id,
      workflow: r.workflow,
      firstTs: new Date(r.first_ts).getTime(),
    }),
  )
}

async function readHead(file: string): Promise<string> {
  const text = await Bun.file(file).slice(0, PROMPT_BYTES).text()
  const end = text.lastIndexOf('\n')
  return end === -1 ? text : text.slice(0, end)
}

/**
 * Decide the repo of every claude-code session without one and without a verdict yet. Reads the database and the
 * transcripts, writes nothing. A session whose transcript is not on disk (a MacBook mirror that has not synced) gets no
 * verdict unless its parent or neighbours resolve it, so it is tried again next run.
 */
export async function resolveSessionRepos(
  sql: Db,
  opts: SessionRepoOptions = {},
): Promise<SessionRepoResult[]> {
  const todo = await candidates(sql, opts)
  if (todo.length === 0) return []
  const files = await indexTranscripts(opts.roots ?? claudeCodeRoots())
  const resolveSha = shaResolver(opts.gitRepos ?? defaultGitRepos())
  const results = new Map<number, SessionRepoResult>()
  const scanned = new Set<number>()
  const set = (id: number, repo: string, evidence: Evidence): void => {
    results.set(id, { sessionId: id, repo, evidence })
  }

  // Parents first: a subagent can then take its parent's verdict from this run.
  const ordered = [...todo].sort(
    (a, b) => Number(a.parentId !== null) - Number(b.parentId !== null),
  )
  for (const c of ordered) {
    const file = files.get(c.key)
    if (!file) continue
    scanned.add(c.id)
    const prompt = firstPrompt(await readHead(file))
    const sha = prompt ? diffSha(prompt) : null
    const bySha = sha ? resolveSha(sha) : null
    if (bySha) {
      set(c.id, bySha, 'git-sha')
      continue
    }
    const byPaths = pathsRepo(await Bun.file(file).slice(0, TRANSCRIPT_BYTES).text())
    if (byPaths) set(c.id, byPaths, 'transcript-paths')
  }

  // parent
  const parentIds = [...new Set(todo.flatMap((c) => (c.parentId === null ? [] : [c.parentId])))]
  const parentRepo = new Map<number, string>()
  if (parentIds.length > 0) {
    const rows = await sql.unsafe(
      `SELECT s.id::int AS id, coalesce(s.repo, e.repo) AS repo
       FROM usage.sessions s LEFT JOIN usage.session_repo e ON e.session_id = s.id
       WHERE s.id = ANY($1::bigint[]) AND coalesce(s.repo, e.repo) IS NOT NULL`,
      [parentIds],
    )
    for (const r of rows) parentRepo.set(r.id, r.repo)
  }
  for (const c of ordered) {
    if (results.has(c.id) || c.parentId === null) continue
    const repo = results.get(c.parentId)?.repo ?? parentRepo.get(c.parentId)
    if (repo) set(c.id, repo, 'parent')
  }

  // neighbor
  const withWorkflow = todo.filter((c) => c.workflow && !results.has(c.id))
  if (withWorkflow.length > 0) {
    const lo = Math.min(...withWorkflow.map((c) => c.firstTs)) - NEIGHBOR_MS
    const hi = Math.max(...withWorkflow.map((c) => c.firstTs)) + NEIGHBOR_MS
    const rows = await sql.unsafe(
      `SELECT s.lane_detail->>'workflow' AS workflow, s.first_ts, coalesce(s.repo, e.repo) AS repo
       FROM usage.sessions s LEFT JOIN usage.session_repo e ON e.session_id = s.id
       WHERE s.source = 'claude-code' AND s.lane_detail->>'workflow' IS NOT NULL AND coalesce(s.repo, e.repo) IS NOT NULL
         AND s.first_ts BETWEEN $1::timestamptz AND $2::timestamptz`,
      [new Date(lo).toISOString(), new Date(hi).toISOString()],
    )
    const known: Array<{ workflow: string; ts: number; repo: string }> = rows.map(
      (r: { workflow: string; first_ts: Date; repo: string }) => ({
        workflow: r.workflow,
        ts: new Date(r.first_ts).getTime(),
        repo: r.repo,
      }),
    )
    for (const r of results.values()) {
      const c = todo.find((t) => t.id === r.sessionId)
      if (c?.workflow && r.repo) known.push({ workflow: c.workflow, ts: c.firstTs, repo: r.repo })
    }
    for (const c of withWorkflow) {
      const repos = new Set(
        known
          .filter((k) => k.workflow === c.workflow && Math.abs(k.ts - c.firstTs) <= NEIGHBOR_MS)
          .map((k) => k.repo),
      )
      if (repos.size === 1) set(c.id, [...repos][0] as string, 'neighbor')
    }
  }

  for (const id of scanned)
    if (!results.has(id)) results.set(id, { sessionId: id, repo: null, evidence: 'none' })
  return [...results.values()]
}

/** Store the verdicts. A found repo is final; a `none` is replaced by a later scan, which runs once the session has grown. */
export async function saveSessionRepos(sql: Db, results: SessionRepoResult[]): Promise<void> {
  for (let i = 0; i < results.length; i += 500) {
    await sql.unsafe(
      `INSERT INTO usage.session_repo (session_id, repo, evidence)
       SELECT j.session_id, j.repo, j.evidence
       FROM jsonb_to_recordset($1::text::jsonb) AS j(session_id bigint, repo text, evidence text)
       ORDER BY j.session_id
       ON CONFLICT (session_id) DO UPDATE
         SET repo = EXCLUDED.repo, evidence = EXCLUDED.evidence, scanned_at = now()
         WHERE usage.session_repo.evidence = 'none'`,
      [
        payload(
          results
            .slice(i, i + 500)
            .map((r) => ({ session_id: r.sessionId, repo: r.repo, evidence: r.evidence })),
        ),
      ],
    )
  }
}
