-- Session repo evidence (src/pg/session-repo.ts). A claude-code session whose cwd names no repo (a deleted UUID worktree
-- under ~/.local/state/{agent-gateway,sideclaw}/worktrees, the bare home or SourceRoot) is resolved from its transcript:
-- the commit its first prompt diffs against, the paths its tools touched, its parent, its neighbours in the same workflow.
-- One row per scanned session; repo NULL with evidence 'none' records that the scan found nothing, so it is not repeated.
-- usage.sessions.repo and usage.records.repo take the value in the repair pass (src/pg/repair.ts), this table is the proof.

CREATE TABLE usage.session_repo (
  session_id bigint      PRIMARY KEY REFERENCES usage.sessions (id) ON DELETE CASCADE,
  repo       text,
  evidence   text        NOT NULL CHECK (evidence IN ('git-sha', 'transcript-paths', 'parent', 'neighbor', 'none')),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((evidence = 'none') = (repo IS NULL))
);
