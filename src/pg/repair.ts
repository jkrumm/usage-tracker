import type { SQL } from 'bun'
import { normalizeModel } from '../models.ts'
import { baseModel } from '../prices/aliases.ts'
import { classifyRepo, issueFromPath, renameRepo, workspaceFor, type KnownRepos } from '../repo.ts'
import {
  resolveSessionRepos,
  saveSessionRepos,
  type Db,
  type Evidence,
  type SessionRepoOptions,
} from './session-repo.ts'
import { payload } from './writer.ts'

// The attribution repair pass (docs/usage-schema.md §Repair). Recomputes repo, workspace, model and issue_id of
// usage.records and usage.sessions from the verbatim columns (project_raw, model_raw, lane_detail) with the current rules, so a
// changed rule or a source that bypasses the writer (the agw gateway, agent-workflows) is corrected after the fact:
//
//   stage 1   rule a/b over the distinct (source, project_raw, workspace, caller, origin, purpose) tuples, model
//             normalization over the distinct (model_raw, model) pairs, session renames, issue from worktree paths
//   stage 2   session evidence (src/pg/session-repo.ts) for sessions that still have no repo, saved in usage.session_repo
//   stage 3   the evidence, then rule c/d for what is still NULL, workspace fill, issue from the sessions, and the
//             cutover duplicates (usage.flag_cutover_duplicates)
//
// Set-based over distinct tuples, idempotent (an UPDATE only touches a row whose values differ), never touches a cost
// column, never overwrites a non-NULL workspace or issue_id, never erases a repo. Changed records get a new `ingested_at`
// so a reader that syncs by it sees the correction. A dry run does the same inside a transaction it rolls back.

/** An ongoing pass looks at this many days; `full` at everything. */
const RECENT_DAYS = 3
const BATCH = 1000

export interface RepairOptions {
  dryRun?: boolean
  full?: boolean
  now?: Date
  /** Replace the repo list `classifyRepo` checks bare slugs against (tests). */
  known?: KnownRepos
  /** Transcript roots and git checkouts of the evidence scan (tests). */
  evidence?: Pick<SessionRepoOptions, 'roots' | 'gitRepos' | 'limit'>
}

export interface RepoCost {
  repo: string
  rows: { before: number; after: number }
  cost: { before: number; after: number }
}

export interface RepairResult {
  /** Rows (records + sessions) whose repo / workspace / model / issue_id changed, and duplicates newly marked. */
  repo: number
  workspace: number
  model: number
  issue: number
  duplicates: number
  /** Verdicts of the session evidence scan by kind. */
  evidence: Partial<Record<Evidence, number>>
  /** Dry run only: records and cost per repo before and after, for the repos that moved. */
  byRepo?: RepoCost[]
}

class Rollback extends Error {}

interface Counts {
  repo: number
  workspace: number
  model: number
  issue: number
}

const zero = (): Counts => ({ repo: 0, workspace: 0, model: 0, issue: 0 })
const add = (a: Counts, b: Partial<Counts>): void => {
  a.repo += b.repo ?? 0
  a.workspace += b.workspace ?? 0
  a.model += b.model ?? 0
  a.issue += b.issue ?? 0
}

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.unsafe(
    `WITH u AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM u`,
    params,
  )
  return Number(row.n)
}

/**
 * The recent-window and ingested_at fragments of a pass. Built from Date.toISOString() values only, never from input, so
 * they are inlined: an unreferenced bind parameter is an error in Postgres, and most statements need neither.
 */
interface Ctx {
  rec: string
  ses: string
  now: string
}

function context(since: Date | null, now: Date | null): Ctx {
  return {
    rec: since ? `r.ts >= '${since.toISOString()}'::timestamptz` : 'true',
    ses: since ? `s.last_ts >= '${since.toISOString()}'::timestamptz` : 'true',
    now: now ? `'${now.toISOString()}'::timestamptz` : 'now()',
  }
}

const modelOf = (m: string | null): string | null => {
  const n = normalizeModel(m)
  return n ? baseModel(n) : null
}

interface Tuple {
  source: string
  project_raw: string | null
  workspace: string | null
  caller: string | null
  origin: string | null
  purpose: string | null
}

interface TupleRule extends Tuple {
  ab: string | null
  cd: string | null
  ws: string | null
  issue: string | null
}

/**
 * Update records by their value tuple. `repoExpr` is the new repo: stage 1 `coalesce(t.ab, r.repo)` (a/b wins, a NULL keeps
 * the stored one), stage 3 `coalesce(r.repo, t.cd)` (fills only what is still NULL). Workspace and issue_id fill only NULLs.
 */
// NULL-safe equality is spelled coalesce(x, chr(1)) = coalesce(y, chr(1)), not IS NOT DISTINCT FROM: only the former can be a hash join
// (the latter is a nested loop over every record per tuple, minutes on a million rows).
const tupleUpdateSql = (repoExpr: string, c: Ctx): string => `
WITH t AS (
  SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS t(
    source text, project_raw text, workspace text, caller text, origin text, purpose text,
    ab text, cd text, ws text, issue text)
), n AS (
  SELECT r.id, r.repo AS old_repo, r.workspace AS old_ws, r.issue_id AS old_issue,
         ${repoExpr} AS repo,
         coalesce(r.workspace, t.ws,
                  CASE WHEN ${repoExpr} IS NULL THEN NULL WHEN ${repoExpr} LIKE 'iu/%' THEN 'work' ELSE 'private' END) AS workspace,
         coalesce(r.issue_id, t.issue) AS issue
  FROM usage.records r JOIN t
    ON r.source = t.source
   AND coalesce(r.project_raw, chr(1)) = coalesce(t.project_raw, chr(1))
   AND coalesce(r.workspace, chr(1)) = coalesce(t.workspace, chr(1))
   AND coalesce(r.lane_detail->>'caller', chr(1)) = coalesce(t.caller, chr(1))
   AND coalesce(r.lane_detail->>'origin', chr(1)) = coalesce(t.origin, chr(1))
   AND coalesce(r.lane_detail->>'purpose', chr(1)) = coalesce(t.purpose, chr(1))
  WHERE ${c.rec}
), u AS (
  UPDATE usage.records r
  SET repo = n.repo, workspace = n.workspace, issue_id = n.issue, ingested_at = ${c.now}
  FROM n
  WHERE r.id = n.id AND (r.repo, r.workspace, r.issue_id) IS DISTINCT FROM (n.repo, n.workspace, n.issue)
  RETURNING n.old_repo, n.repo, n.old_ws, n.workspace, n.old_issue, n.issue
)
SELECT count(*) FILTER (WHERE old_repo IS DISTINCT FROM repo)::int AS repo,
       count(*) FILTER (WHERE old_ws IS DISTINCT FROM workspace)::int AS workspace,
       count(*) FILTER (WHERE old_issue IS DISTINCT FROM issue)::int AS issue
FROM u`

const stage1Sql = (c: Ctx): string => tupleUpdateSql('coalesce(t.ab, r.repo)', c)
const stage3Sql = (c: Ctx): string => tupleUpdateSql('coalesce(r.repo, t.cd)', c)

/**
 * The tuples whose rows would change at this stage: the distinct tuples are grouped with the stored repo, workspace and
 * issue_id too, and a tuple whose every variant already holds the computed values is not sent, so a repeated pass scans
 * nothing. `stage` is which repo rule applies: `ab` (stage 1, wins over the stored repo) or `cd` (stage 3, fills a NULL).
 */
async function tupleRules(
  db: Db,
  c: Ctx,
  stage: 'ab' | 'cd',
  known: KnownRepos | undefined,
): Promise<TupleRule[]> {
  const rows: Array<Tuple & { repo: string | null; issue_id: string | null }> = await db.unsafe(
    `SELECT r.source, r.project_raw, r.workspace, r.lane_detail->>'caller' AS caller,
            r.lane_detail->>'origin' AS origin, r.lane_detail->>'purpose' AS purpose, r.repo, r.issue_id
     FROM usage.records r WHERE ${c.rec}
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
  )
  const out = new Map<string, TupleRule>()
  for (const t of rows) {
    const rule: TupleRule = {
      source: t.source,
      project_raw: t.project_raw,
      workspace: t.workspace,
      caller: t.caller,
      origin: t.origin,
      purpose: t.purpose,
      ab: classifyRepo({ project: t.project_raw, workspace: t.workspace }, known),
      cd: classifyRepo(
        { source: t.source, caller: t.caller, origin: t.origin, purpose: t.purpose },
        known,
      ),
      ws: workspaceFor(t.project_raw, null),
      issue: issueFromPath(t.project_raw),
    }
    const repo = stage === 'ab' ? (rule.ab ?? t.repo) : (t.repo ?? rule.cd)
    const workspace =
      t.workspace ?? rule.ws ?? (repo === null ? null : repo.startsWith('iu/') ? 'work' : 'private')
    const changes =
      repo !== t.repo || workspace !== t.workspace || (t.issue_id ?? rule.issue) !== t.issue_id
    if (changes)
      out.set(
        JSON.stringify([t.source, t.project_raw, t.workspace, t.caller, t.origin, t.purpose]),
        rule,
      )
  }
  return [...out.values()]
}

async function applyTuples(db: Db, sql: string, rules: TupleRule[]): Promise<Partial<Counts>> {
  const out = zero()
  for (let i = 0; i < rules.length; i += BATCH) {
    const [row] = await db.unsafe(sql, [payload(rules.slice(i, i + BATCH))])
    out.repo += Number(row.repo)
    out.workspace += Number(row.workspace)
    out.issue += Number(row.issue)
  }
  return out
}

/** Model normalization over the distinct (model_raw, model) pairs and the distinct session models. */
async function repairModels(db: Db, c: Ctx): Promise<number> {
  const pairs: Array<{ model_raw: string | null; model: string | null }> = await db.unsafe(
    `SELECT r.model_raw, r.model FROM usage.records r WHERE ${c.rec} GROUP BY 1, 2`,
  )
  // The stored `model` is normalized again (the gateway resolves aliases the writer does not know: haiku, decision-1);
  // only a row without one falls back to model_raw.
  const changes = pairs.flatMap((p) => {
    const next = modelOf(p.model ?? p.model_raw)
    return next && next !== p.model ? [{ ...p, new_model: next }] : []
  })
  let n = 0
  for (let i = 0; i < changes.length; i += BATCH) {
    n += await count(
      db,
      `WITH t AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS t(model_raw text, model text, new_model text))
       UPDATE usage.records r SET model = t.new_model, ingested_at = ${c.now}
       FROM t
       WHERE coalesce(r.model_raw, chr(1)) = coalesce(t.model_raw, chr(1)) AND coalesce(r.model, chr(1)) = coalesce(t.model, chr(1)) AND ${c.rec}`,
      [payload(changes.slice(i, i + BATCH))],
    )
  }
  const sessionModels: Array<{ model: string }> = await db.unsafe(
    `SELECT DISTINCT s.model FROM usage.sessions s WHERE s.model IS NOT NULL AND ${c.ses}`,
  )
  const sessionChanges = sessionModels.flatMap((m) => {
    const next = modelOf(m.model)
    return next && next !== m.model ? [{ model: m.model, new_model: next }] : []
  })
  for (let i = 0; i < sessionChanges.length; i += BATCH) {
    n += await count(
      db,
      `WITH t AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS t(model text, new_model text))
       UPDATE usage.sessions s SET model = t.new_model FROM t WHERE s.model = t.model AND ${c.ses}`,
      [payload(sessionChanges.slice(i, i + BATCH))],
    )
  }
  return n
}

/** Sessions: renamed repos, then NULL repos from the session's earliest record that has one. */
async function repairSessionRepos(db: Db, c: Ctx): Promise<number> {
  const stored: Array<{ repo: string }> = await db.unsafe(
    `SELECT DISTINCT s.repo FROM usage.sessions s WHERE s.repo IS NOT NULL AND ${c.ses}`,
  )
  const renames = stored.flatMap((s) => {
    const next = renameRepo(s.repo)
    return next !== s.repo ? [{ repo: s.repo, new_repo: next }] : []
  })
  let n = 0
  for (let i = 0; i < renames.length; i += BATCH) {
    n += await count(
      db,
      `WITH t AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS t(repo text, new_repo text))
       UPDATE usage.sessions s SET repo = t.new_repo FROM t WHERE s.repo = t.repo AND ${c.ses}`,
      [payload(renames.slice(i, i + BATCH))],
    )
  }
  n += await count(
    db,
    `UPDATE usage.sessions s SET repo = x.repo
     FROM (SELECT DISTINCT ON (r.session_id) r.session_id, r.repo
           FROM usage.records r JOIN usage.sessions s0 ON s0.id = r.session_id
           WHERE s0.repo IS NULL AND r.repo IS NOT NULL
           ORDER BY r.session_id, r.ts, r.id) x
     WHERE s.id = x.session_id AND s.repo IS NULL AND ${c.ses}`,
  )
  return n
}

/** Evidence verdicts into sessions and records that still have no repo. */
async function applyEvidence(db: Db, c: Ctx): Promise<number> {
  let n = await count(
    db,
    `UPDATE usage.sessions s SET repo = e.repo
     FROM usage.session_repo e WHERE e.session_id = s.id AND e.repo IS NOT NULL AND s.repo IS NULL AND ${c.ses}`,
  )
  n += await count(
    db,
    `UPDATE usage.records r SET repo = e.repo, ingested_at = ${c.now}
     FROM usage.session_repo e
     WHERE e.session_id = r.session_id AND e.repo IS NOT NULL AND r.repo IS NULL AND ${c.rec}`,
  )
  return n
}

/** Workspace of a record whose repo is known and whose workspace is not. */
async function fillWorkspace(db: Db, c: Ctx): Promise<number> {
  return count(
    db,
    `UPDATE usage.records r
     SET workspace = CASE WHEN r.repo LIKE 'iu/%' THEN 'work' ELSE 'private' END, ingested_at = ${c.now}
     WHERE r.workspace IS NULL AND r.repo IS NOT NULL AND ${c.rec}`,
  )
}

/**
 * issue_id of the sessions: from their own records (worktree paths), the factory session of their session_env line
 * (`lead-<n>-<k>`), their parent; then of the records from their session. Only NULLs are filled.
 */
async function repairIssues(db: Db, c: Ctx): Promise<number> {
  let n = await count(
    db,
    `UPDATE usage.sessions s SET issue_id = x.issue_id
     FROM (SELECT DISTINCT ON (r.session_id) r.session_id, r.issue_id
           FROM usage.records r JOIN usage.sessions s0 ON s0.id = r.session_id
           WHERE s0.issue_id IS NULL AND r.issue_id IS NOT NULL
           ORDER BY r.session_id, r.ts, r.id) x
     WHERE s.id = x.session_id AND s.issue_id IS NULL AND ${c.ses}`,
  )
  n += await count(
    db,
    `UPDATE usage.sessions s SET issue_id = substring(e.factory_session FROM '^lead-(\\d+)-\\d+$')
     FROM usage.session_env e
     WHERE s.source = 'claude-code' AND s.source_session_id = e.session AND s.issue_id IS NULL
       AND e.factory_session ~ '^lead-\\d+-\\d+$' AND ${c.ses}`,
  )
  n += await count(
    db,
    `UPDATE usage.sessions s SET issue_id = p.issue_id
     FROM usage.sessions p
     WHERE s.parent_session_id = p.id AND s.issue_id IS NULL AND p.issue_id IS NOT NULL AND ${c.ses}`,
  )
  n += await count(
    db,
    `UPDATE usage.records r SET issue_id = s.issue_id, ingested_at = ${c.now}
     FROM usage.sessions s
     WHERE r.session_id = s.id AND r.issue_id IS NULL AND s.issue_id IS NOT NULL AND ${c.rec}`,
  )
  return n
}

async function repoSnapshot(db: Db, c: Ctx): Promise<Map<string, { rows: number; cost: number }>> {
  const rows: Array<{ repo: string; rows: number; cost: number }> = await db.unsafe(
    `SELECT coalesce(r.repo, '(none)') AS repo, count(*)::int AS rows, coalesce(sum(r.cost_usd), 0)::float8 AS cost
     FROM usage.records r WHERE ${c.rec} GROUP BY 1`,
  )
  return new Map(rows.map((r) => [r.repo, { rows: Number(r.rows), cost: Number(r.cost) }]))
}

interface Totals {
  counts: Counts
  duplicates: number
  evidence: Partial<Record<Evidence, number>>
}

/**
 * The whole pass against `db`. `atomic` runs a stage as one transaction: the real pass commits stages 1 and 3 separately
 * (the transcript scan of stage 2 must not hold row locks), a dry run runs all of them inside its one rolled-back transaction.
 */
async function run(
  db: Db,
  opts: RepairOptions,
  c: Ctx,
  atomic: (fn: (tx: Db) => Promise<void>) => Promise<void>,
): Promise<Totals> {
  const counts = zero()
  const evidence: Totals['evidence'] = {}
  let duplicates = 0

  await atomic(async (tx) => {
    add(counts, await applyTuples(tx, stage1Sql(c), await tupleRules(tx, c, 'ab', opts.known)))
    counts.model += await repairModels(tx, c)
    counts.repo += await repairSessionRepos(tx, c)
    counts.issue += await repairIssues(tx, c)
  })

  const verdicts = await resolveSessionRepos(db, {
    ...opts.evidence,
    sinceDays: opts.full ? undefined : RECENT_DAYS,
  })
  await saveSessionRepos(db, verdicts)
  for (const v of verdicts) evidence[v.evidence] = (evidence[v.evidence] ?? 0) + 1

  await atomic(async (tx) => {
    counts.repo += await applyEvidence(tx, c)
    add(counts, await applyTuples(tx, stage3Sql(c), await tupleRules(tx, c, 'cd', opts.known)))
    counts.workspace += await fillWorkspace(tx, c)
    counts.repo += await repairSessionRepos(tx, c)
    counts.issue += await repairIssues(tx, c)
    const [row] = await tx.unsafe('SELECT usage.flag_cutover_duplicates()::int AS n')
    duplicates = Number(row.n)
  })
  return { counts, duplicates, evidence }
}

/**
 * Repair the attribution of usage.records and usage.sessions. Ongoing: the last three days; `full`: everything.
 * `dryRun` executes the same statements inside a transaction that is rolled back and reports what would change, with
 * the records and cost per repo before and after.
 */
export async function repairAttribution(sql: SQL, opts: RepairOptions = {}): Promise<RepairResult> {
  const now = opts.now ?? null
  const since = opts.full
    ? null
    : new Date((now ?? new Date()).getTime() - RECENT_DAYS * 86_400_000)
  const c = context(since, now)

  if (!opts.dryRun) {
    const t = await run(sql, opts, c, async (fn) => {
      await sql.begin(async (tx) => {
        await fn(tx)
      })
    })
    return { ...t.counts, duplicates: t.duplicates, evidence: t.evidence }
  }

  let result: RepairResult | undefined
  try {
    await sql.begin(async (tx) => {
      const before = await repoSnapshot(tx, c)
      const t = await run(tx, opts, c, (fn) => fn(tx))
      const after = await repoSnapshot(tx, c)
      const byRepo: RepoCost[] = []
      for (const repo of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(repo) ?? { rows: 0, cost: 0 }
        const a = after.get(repo) ?? { rows: 0, cost: 0 }
        if (a.rows !== b.rows || a.cost !== b.cost)
          byRepo.push({
            repo,
            rows: { before: b.rows, after: a.rows },
            cost: { before: b.cost, after: a.cost },
          })
      }
      byRepo.sort(
        (x, y) => Math.abs(y.cost.after - y.cost.before) - Math.abs(x.cost.after - x.cost.before),
      )
      result = { ...t.counts, duplicates: t.duplicates, evidence: t.evidence, byRepo }
      throw new Rollback()
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
  return result as RepairResult
}

/** The dry run as text, for the CLI. */
export function formatRepair(r: RepairResult, dryRun: boolean): string {
  const lines = [
    `repair${dryRun ? ' (dry run, rolled back)' : ''}: repo ${r.repo}, workspace ${r.workspace}, model ${r.model}, issue ${r.issue}, duplicates ${r.duplicates}`,
    `session evidence: ${
      Object.entries(r.evidence)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ') || 'none scanned'
    }`,
  ]
  for (const m of r.byRepo ?? [])
    lines.push(
      `  ${m.repo.padEnd(34)} rows ${m.rows.before} -> ${m.rows.after}   cost ${m.cost.before.toFixed(2)} -> ${m.cost.after.toFixed(2)}`,
    )
  return lines.join('\n')
}
