import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Repo classification for usage.records.repo (decision U4). Argo's "project" dimension reads this column, so almost every
// row should carry one. `normalizeRepo` maps a PATH to the slug the software factory's projects use; `classifyRepo`
// adds everything a collector does not say in a path (bare slugs, the source's owner, the caller) and is what the
// writer and the repair pass call. The raw string always stays in `project_raw` (and `model_raw`), so all of this is
// recomputable: change a rule here, run `make repair FULL=1`.
//
//   /Users/<any>/SourceRoot/argo/apps/api            -> argo
//   /Users/<any>/SourceRoot/argo/.claude/worktrees/x -> argo        (the first directory under SourceRoot wins)
//   /Users/<any>/SourceRoot/warden-w6                -> warden      (sibling worktree: <repo>-w<N>[-trial])
//   /Users/<any>/SourceRoot/shutterflow-wt/p3-05     -> shutterflow (worktree container: <repo>-wt)
//   /Users/<any>/SourceRoot/worktrees/<repo>/factory-141-1 -> <repo>
//   /Users/<any>/IuRoot/epos-tool-athena/src         -> iu/epos-tool-athena  (own namespace, never a factory slug)
//   /Users/<any>/IuRoot/worktrees/tool-b             -> iu/epos-tool-athena  (branch worktree: prefix table below)
//   bare SourceRoot / IuRoot, empty, anything else   -> null
//
// Dot-directories (.hermes-wt, .wt) are scratch space and temp paths belong to no repo: null.

const ROOT = /^\/(?:Users|home)\/[^/]+\/(SourceRoot|IuRoot)(?:\/([^/]+))?(?:\/([^/]+))?/
const SIBLING_WORKTREE = /^(.+?)-(?:w\d+(?:-trial)?|wt)$/
const HERMES_PATH = /^\/(?:Users|home)\/[^/]+\/\.hermes\/hermes-agent(?:\/|$)/
const IU_WIP =
  /^\/(?:Users|home)\/[^/]+\/IuRoot\/prometheus-scripts\/wip\/(athena-context-poc|waves-2026-10-22-teamchat)(?:\/|$)/

const TEAMCHAT = 'iu/epos-ai-teamchat-athena'

/** `IuRoot/worktrees/<name>` names a branch, not a repo: the prefix says which repo it branched from. No hit: null. */
const IU_WORKTREES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(?:se-|student-enrolment|EP-17678|EP-18347-(?:pipeline-admission-dates|shell-cleanup|ownership-anchor))/,
    'iu/epos-studentenrolment-backend',
  ],
  [/^(?:tool-|ps-|prom-|prometheus-dashboard)/, 'iu/epos-tool-athena'],
  [/^teamchat-/, TEAMCHAT],
  [/^otf-/, 'iu/epos-otf-workspaces'],
  [/^dam-/, 'iu/epos-dam-backend'],
  [/^import-dashboard-/, 'iu/epos-import-dashboard-athena'],
]

/** A repo that was renamed or merged (evidence: ~/IuRoot/.archive/README.md, github-migration-handover.md). */
const RENAMES: Readonly<Record<string, string>> = {
  'iu/prometheus-epx': TEAMCHAT,
  'iu/prometheus-scripts': 'iu/epos-tool-athena',
  'iu/epos.student-enrolment': 'iu/epos-studentenrolment-backend',
  'iu/se-wt-loa-credits': 'iu/epos-studentenrolment-backend',
  'iu/epos.dam': 'iu/epos-dam-backend',
  ShutterflowOps: 'shutterflow',
  'king-smith-mac': 'king-smith-walkingpad-mac',
}

/** Scratch and trial checkouts of a repo fold into it. `fan-scratch` and `dispatch-scratch` stay. */
const FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^factory-(?:gate-|gameday|scratch-|w3-proof)/, 'software-factory'],
  [/^sy-serendipity-/, 'sy-serendipity'],
  [/^linewatch-basalt-/, 'linewatch'],
  [/^bun-email-api-/, 'bun-email-api'],
  [
    /^(?:basalt-expr-trial|basalt-dx-trial$|basalt-ui-obsidian-trial$|basalt-ui-playground$)/,
    'basalt-ui',
  ],
  [/^free-planning-poker-/, 'free-planning-poker'],
]

/** Applied to every classification result: the current name of a repo. */
export function renameRepo(repo: string): string {
  const renamed = RENAMES[repo]
  if (renamed) return renamed
  if (repo.startsWith('iu/')) return repo
  return FOLDS.find(([re]) => re.test(repo))?.[1] ?? repo
}

/** IU repos by their directory name, current and archived: a bare slug in this list is an IU repo whatever the workspace. */
const IU_SLUGS: ReadonlySet<string> = new Set([
  'athena-github-presentation',
  'care-knowledge',
  'cfn-kafka',
  'crm-bridge-retry-tool',
  'epos_fe.academic-profile',
  'epos_fe.booking',
  'epos_fe.customer-navigation',
  'epos_fe.spa-orchestrator',
  'epos-ai-teamchat-athena',
  'epos-backend-integration',
  'epos-cluster-skills',
  'epos-customers-frontend',
  'epos-dam-backend',
  'epos-data-analytics',
  'epos-import-dashboard-athena',
  'epos-knowledge-athena',
  'epos-orchestrator-frontend',
  'epos-otf-workspaces',
  'epos-studentenrolment-backend',
  'epos-tool-athena',
  'epos.crm-bridge',
  'epos.exam',
  'epos.finance-bridge',
  'epos.iam',
  'epos.study-progress',
  'infra-github-access',
  'infra-pilot',
  'prometheus-feuer-agent',
  'prometheus-stack',
  'terraform-monitoring',
  // archived and renamed (RENAMES maps them on)
  'prometheus-epx',
  'prometheus-scripts',
  'epos.student-enrolment',
  'epos.dam',
  'se-wt-loa-credits',
])

/** Bare tokens that name a tool or a job, not a repo: they fall through to the source and caller rules. */
const NON_REPO_SLUGS: ReadonlySet<string> = new Set([
  'claude-code',
  'cli',
  'cron',
  'johannes.krumm',
])

/** Bare tokens that are a repo under another name. */
const SLUG_ALIASES: Readonly<Record<string, string>> = {
  eval: 'agent-workflows',
  host: 'agent-workflows',
  hermes: 'hermes-agent',
  'athena-context-poc': TEAMCHAT,
  'waves-2026-10-22-teamchat': TEAMCHAT,
  'athena-teamchat': TEAMCHAT,
}

/** The repo a source belongs to. The agent-gateway sources apply only after session evidence has been tried. */
const SOURCE_OWNERS: Readonly<Record<string, string>> = {
  hermes: 'hermes-agent',
  'athena-teamchat': TEAMCHAT,
  'research-gateway': 'research-gateway',
  'audio-gateway': 'audio-gateway',
  'image-gateway': 'image-gateway',
  'email-gateway': 'email-gateway',
  modelpick: 'modelpick',
  argo: 'argo',
  'audio-gateway-mini': 'audio-gateway',
  'audio-gateway-vps': 'audio-gateway',
  'audio-proxy': 'audio-gateway',
  'image-gen-gateway': 'image-gateway',
  'agent-gateway-iu': 'agent-gateway',
  'agent-gateway-opencode': 'agent-gateway',
  'agent-gateway-sessions': 'agent-gateway',
}

/** A caller or origin that names a repo. `claude-code`, `cli`, `agw`, `agw-opencode` and `oc` say nothing. */
const CALLER_OWNERS: Readonly<Record<string, string>> = {
  iris: 'iris',
  hermes: 'hermes-agent',
  modelpick: 'modelpick',
  argo: 'argo',
  eval: 'agent-workflows',
  host: 'agent-workflows',
}

/** Retired real repos (no checkout any more) that still carry usage: they keep their own name. */
export const RETIRED_REPOS: readonly string[] = [
  'agent-gateway',
  'agentsmd-poc',
  'audio-gateway',
  'audio-proxy',
  'bun-email-api',
  'claude-local',
  'clawbar',
  'fan-scratch',
  'hark',
  'image-gen',
  'image-share',
  'meteo',
  'photo-flow',
  'research-gateway',
  'sideclaw',
  'ticktick-raycast',
  'vibe-stack',
  'warden',
]

export function normalizeRepo(project: string | null | undefined): string | null {
  if (!project) return null
  const m = ROOT.exec(project.trim())
  if (!m) return null
  const [, root, dir, sub] = m
  if (!dir || dir.startsWith('.')) return null
  if (dir === 'worktrees') {
    if (!sub || sub.startsWith('.')) return null
    if (root === 'SourceRoot') return sub
    if (IU_SLUGS.has(sub)) return `iu/${sub}`
    return IU_WORKTREES.find(([re]) => re.test(sub))?.[1] ?? null
  }
  if (root === 'IuRoot') return `iu/${dir}`
  return SIBLING_WORKTREE.exec(dir)?.[1] ?? dir
}

export interface KnownRepos {
  has(repo: string): boolean
}

export interface KnownRepoRoots {
  sourceRoot?: string
  iuRoot?: string
}

/** Every repo that exists: the directories under SourceRoot and IuRoot (`iu/<dir>`) plus the retired ones. */
export function knownRepos(roots: KnownRepoRoots = {}): ReadonlySet<string> {
  const known = new Set<string>(RETIRED_REPOS)
  const add = (root: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'worktrees') continue
      known.add(prefix + e.name)
    }
  }
  add(roots.sourceRoot ?? join(homedir(), 'SourceRoot'), '')
  add(roots.iuRoot ?? join(homedir(), 'IuRoot'), 'iu/')
  return known
}

let cachedKnown: ReadonlySet<string> | undefined
const defaultKnown = (): ReadonlySet<string> => (cachedKnown ??= knownRepos())

export interface RepoInput {
  project?: string | null
  workspace?: string | null
  source?: string | null
  caller?: string | null
  origin?: string | null
  purpose?: string | null
  /** The repo a session's transcript points at (usage.session_repo): tried between the project rules and the source rules. */
  evidence?: string | null
}

function bareSlug(slug: string, workspace: string | null, known: KnownRepos): string | null {
  if (NON_REPO_SLUGS.has(slug)) return null
  const alias = SLUG_ALIASES[slug]
  if (alias) return alias
  if (IU_SLUGS.has(slug) || known.has(`iu/${slug}`)) return `iu/${slug}`
  if (workspace === 'work') return null
  return known.has(slug) ? slug : null
}

/** Rules a and b: what the collector's own project string says. */
function fromProject(project: string, workspace: string | null, known: KnownRepos): string | null {
  const p = project.trim()
  if (!p) return null
  if (p.startsWith('/')) {
    if (HERMES_PATH.test(p)) return 'hermes-agent'
    if (IU_WIP.test(p)) return TEAMCHAT
    return normalizeRepo(p)
  }
  if (p.includes('/')) return null
  return bareSlug(p, workspace, known)
}

/** Rules c and d: what the source, caller, origin or purpose owns. */
function fromSource(i: RepoInput): string | null {
  const owner = i.source ? SOURCE_OWNERS[i.source] : undefined
  if (owner) return owner
  for (const key of [i.origin, i.caller]) {
    const hit = key ? CALLER_OWNERS[key] : undefined
    if (hit) return hit
  }
  return i.purpose === 'eval' ? 'agent-workflows' : null
}

/**
 * The repo of one usage row, first hit wins: (a) the project path, (b) a bare project slug, then the session's
 * transcript evidence, (c) the source's owner, (d) the origin / caller / purpose. A rename or fold is applied to
 * whatever wins. NULL when nothing says (the caller keeps the raw project in `project_raw`).
 */
export function classifyRepo(i: RepoInput, known: KnownRepos = defaultKnown()): string | null {
  const hit =
    (i.project ? fromProject(i.project, i.workspace ?? null, known) : null) ??
    i.evidence ??
    fromSource(i)
  return hit ? renameRepo(hit) : null
}

/** Workspace of a row whose collector gave none: IuRoot paths and `iu/*` repos are work, every other repo and path private. */
export function workspaceFor(
  project: string | null | undefined,
  repo: string | null,
): 'work' | 'private' | null {
  const root = project ? ROOT.exec(project.trim())?.[1] : undefined
  if (root === 'IuRoot') return 'work'
  if (root === 'SourceRoot') return 'private'
  if (!repo) return null
  return repo.startsWith('iu/') ? 'work' : 'private'
}

const FACTORY_WORKTREE = /\/SourceRoot\/worktrees\/[^/]+\/factory-(\d+)-\d+(?:\/|$)/
const LEAD_SESSION = /^lead-(\d+)-\d+$/

/** The factory issue number of a `worktrees/<repo>/factory-<n>-<k>` path, or null. */
export function issueFromPath(project: string | null | undefined): string | null {
  return (project && FACTORY_WORKTREE.exec(project)?.[1]) || null
}

/** The factory issue number of a `lead-<n>-<k>` session id (session_env.factory_session), or null. */
export function issueFromFactorySession(session: string | null | undefined): string | null {
  return (session && LEAD_SESSION.exec(session)?.[1]) || null
}
