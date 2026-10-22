# usage-tracker — waves

## Wave 1 — Factory Phase 0: collect agent-gateway's OpenCode store            <!-- status: done -->
Why: since 2026-10-14 agent-gateway runs its OpenCode v2 server on its own store,
`~/.local/share/agent-gateway/opencode/opencode.db`. The `opencode` collector still reads
`~/.local/share/opencode/opencode.db` (newest row 2026-10-13T12:34Z) and reports ok, and the
`agent-gateway-sessions` rows carry zero tokens and zero cost. usage.db, and Argo's
`usage_record` built on it, have missed all IU OpenCode spend since then. Found by the factory
design's baseline (`~/SourceRoot/dotfiles/docs/factory/evidence/kpi/cost.out.md`); this is a
Phase 0 fix (`~/SourceRoot/dotfiles/docs/factory/STATUS.md`): cost is a control input under any design.

- [x] Collect the agent-gateway OpenCode v2 store: tokens and exact `cost` per message/session, the agw job id from `session_v2.metadata.agw.jobId` kept in the row, project from the job's repo. Either a new source or a corrected `agent-gateway-sessions` — whichever cannot double count; keep the legacy collector for history. Backfill from 2026-10-14.
- [x] Draw the boundary against `agent-gateway-iu` (agw's direct IU calls) explicitly in AGENTS.md so no spend is counted twice or missed; verify with a reconciliation query over one day.
- [x] Staleness fails loudly: every collector has an expected cadence; a newest row older than it makes usage-tracker's health and `make verify` not-ok (and the dev-host heartbeat component, if usage-tracker feeds one), so a moved store can never go silent again.
- [x] Gate: `make check`, `/review` on the diff, `make deploy`, `make verify`. Record in **Left behind**: backfilled rows, tokens and USD since 2026-10-14 per source, and that the next Argo sync carried them.
**Left behind:**
- New source `agent-gateway-opencode` (message grain, exact reported `cost`, `raw.jobId`, `sub_tool` = agw tool, workspace from the directory); legacy `opencode` kept for history. Boundary vs `agent-gateway-iu` / `agent-gateway-sessions` is in AGENTS.md Gotchas; a one-day reconciliation (2026-10-19) showed disjoint lanes and zero `source_id` collisions.
- Backfilled 2026-10-14 → 2026-10-22: 33,652 rows (store holds 33,610 at the scratch run, +42 live), 1.63B tokens (cache-read dominated), 58.47 USD, all `iu`. Other sources over the same window were already collected (agent-gateway-iu 183.55 USD, agent-gateway-sessions 0 by design, claude-code 8,407 USD); the legacy `opencode` source gained nothing, as before.
- Argo: the first deployed ingest pushed `sync: pushed 34051 records in 69 batches`; `agent-gateway-opencode` has 0 unsynced rows.
- Staleness: `staleAfterHours` required on every collector (`null` = legacy/dormant: codex, astra, modelpick, litellm, opencode, feuer); `make health` / `make verify` and `ingest`'s exit code fail on a stale or vanished source (so `jobs-grade` and the heartbeat see it). Sharp edge: a collector that stamps `new Date()` for rows without a timestamp can mask a dead store.
- Gate: `make check` 190 pass; `/review` findings (vanished-store and future-timestamp gate holes, poison-row, store-error → error, scoped ingest check, hermes policy at the registration site) fixed; `make deploy` and `make verify` green. Commit a5fbd23. Not done: pre-existing 1,545 unpriced rows are unrelated.
