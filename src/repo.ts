// Repo normalization for usage.records.repo (decision U4). Input is a collector's raw `project` string; the
// result is the slug the software factory's projects use: the directory name directly under SourceRoot.
//
//   /Users/<any>/SourceRoot/argo/apps/api            -> argo
//   /Users/<any>/SourceRoot/argo/.claude/worktrees/x -> argo        (the first directory under SourceRoot wins)
//   /Users/<any>/SourceRoot/warden-w6                -> warden      (sibling worktree: <repo>-w<N>[-trial])
//   /Users/<any>/SourceRoot/shutterflow-wt/p3-05     -> shutterflow (worktree container: <repo>-wt)
//   /Users/<any>/IuRoot/prometheus-epx/chat          -> iu/prometheus-epx   (own namespace, never a factory slug)
//   bare SourceRoot / IuRoot, empty, anything else   -> null  (the caller keeps the raw string in project_raw)
//
// Nothing is renamed: only the directory name is used. Dot-directories (.hermes-wt, .wt) are scratch space,
// IuRoot/worktrees/<name> names a branch worktree rather than a repo, and temp paths belong to no repo: all null.

const ROOT = /^\/(?:Users|home)\/[^/]+\/(SourceRoot|IuRoot)(?:\/([^/]+))?/
const SIBLING_WORKTREE = /^(.+?)-(?:w\d+(?:-trial)?|wt)$/

export function normalizeRepo(project: string | null | undefined): string | null {
  if (!project) return null
  const m = ROOT.exec(project.trim())
  if (!m) return null
  const dir = m[2]
  if (!dir || dir.startsWith('.')) return null
  if (m[1] === 'IuRoot') return dir === 'worktrees' ? null : `iu/${dir}`
  return SIBLING_WORKTREE.exec(dir)?.[1] ?? dir
}
