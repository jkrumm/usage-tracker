# usage-tracker — waves

## Wave 1 — Factory Phase 0: collect agent-gateway's OpenCode store            <!-- status: active -->
Why: since 2026-10-14 agent-gateway runs its OpenCode v2 server on its own store,
`~/.local/share/agent-gateway/opencode/opencode.db`. The `opencode` collector still reads
`~/.local/share/opencode/opencode.db` (newest row 2026-10-13T12:34Z) and reports ok, and the
`agent-gateway-sessions` rows carry zero tokens and zero cost. usage.db, and Argo's
`usage_record` built on it, have missed all IU OpenCode spend since then. Found by the factory
design's baseline (`~/SourceRoot/dotfiles/docs/factory/evidence/kpi/cost.out.md`); this is a
Phase 0 fix (`~/SourceRoot/dotfiles/docs/factory/STATUS.md`): cost is a control input under any design.

- [ ] Collect the agent-gateway OpenCode v2 store: tokens and exact `cost` per message/session, the agw job id from `session_v2.metadata.agw.jobId` kept in the row, project from the job's repo. Either a new source or a corrected `agent-gateway-sessions` — whichever cannot double count; keep the legacy collector for history. Backfill from 2026-10-14.
- [ ] Draw the boundary against `agent-gateway-iu` (agw's direct IU calls) explicitly in AGENTS.md so no spend is counted twice or missed; verify with a reconciliation query over one day.
- [ ] Staleness fails loudly: every collector has an expected cadence; a newest row older than it makes usage-tracker's health and `make verify` not-ok (and the dev-host heartbeat component, if usage-tracker feeds one), so a moved store can never go silent again.
- [ ] Gate: `make check`, `/review` on the diff, `make deploy`, `make verify`. Record in **Left behind**: backfilled rows, tokens and USD since 2026-10-14 per source, and that the next Argo sync carried them.
**Left behind:**
