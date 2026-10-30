# Track U: the Claude Code cost program on usage v2

**Goal:** every Claude Code session in `usage` carries its lane, role, effort, subagent type and parent; a view gives each
session's share of the 5-hour and 7-day Max windows (U5); a weekly "where the window went" report reaches the owner and
each of its findings becomes a change whose effect the next week's report shows (U6). Decisions U1–U6 and FL4 in
`~/SourceRoot/software-factory/docs/decisions.md`; program state in `~/SourceRoot/software-factory/docs/program.md`.
**Gate:** `make check` in every repo a wave touched (usage-tracker: check the test count, a run with Postgres suites
skipped proves nothing), `/review` on the diff with its blocking findings fixed and one more pass on the fix commits,
pushed to master; usage-tracker's deploy (`AGENTS.md` §Deploy) and a live query against `shared` proving the wave's
claim, written into **Left behind**.

Where things stand (2026-10-30, after A1): U1, U3 and U4 are done (`argo/docs/waves/PLAN.md`). The `sessions` columns for
U2 exist (`migrations/pg/0002`), but over 14 days no session has lane `subagent`, `lead` or `iris`; `effort` and `issue_id`
are always NULL, `run_id` only on agw sessions, and `parent_session_id` is never set (`docs/usage-schema.md` §Parent
links). The window-share rule is written (`docs/usage-schema.md` §Window share) and not built. No weekly report exists;
the Claude Code collector records neither compactions nor skills.

Boundaries: Argo's Usage v2 page is track A2's, not this one; U leaves a view and a CLI that A2 reads. The factory's role
table (`software-factory/config/roles.json`) changes only on this track's measured data (FL4), and the program lead
lands that change in software-factory, not a wave here. All repos here are direct-to-master.

## Wave 1 — Attribution: lane, role, effort, subagent, parent            <!-- status: done -->
- [x] dotfiles `hooks/session-env.ts` also logs `FACTORY_ROLE` and `FACTORY_SESSION` when set (the
  factory runner sets the first two, `software-factory/packages/server/src/runner.ts`); its test covers the new fields.
  Nothing else in dotfiles changes.
- [x] The collector reads them from `usage.session_env`: `FACTORY_ROLE` maps to the lane (`lead`, `wave_mother`, `worker`,
  `fan_worker`; extend `src/lane.ts` and the `sessions.lane` CHECK in a new additive migration only if a role has no lane),
  and the role itself goes into `lane_detail.role`. Today's fallbacks (`USAGE_LANE`, the agw window, the entrypoint)
  stay for sessions without a factory role.
- [x] Effort and subagent type from the transcripts: live transcripts carry `"effort":"high"`; find where (main record,
  subagent file, system record) and fill `records.effort` and `sessions.effort`. `subagents/agent-*.jsonl` records get
  `lane_detail.subagent_type` and the parent link (`raw.parentSessionId`, the rule in `docs/usage-schema.md` §Parent
  links): a subagent becomes its own session with lane `subagent`, linked to its parent, or the record keeps the parent's
  session and carries the type, whichever the schema doc's rules allow without breaking `(source, source_id)` dedup.
  Decide, write the decision into `docs/usage-schema.md`.
- [x] Re-stamp the last 30 days in place (the attribution only; costs untouched), insert-only where a row is new.
- [x] `stats --by lane|role|subagent_type|effort` in the CLI.
**Left behind:** shipped to master (usage-tracker `58b1aa9`, `1015905`, the fix commit after it; dotfiles `8eb7f5f`), migration
`0010` applied, `make deploy` done, `make verify` green. `make check`: 376 pass, 0 fail, 0 skip. `agw review` ran twice (the
second over the whole range); its blocking findings were fixed where they held and the rest are listed below.
- **Decisions** (written into `docs/usage-schema.md` §Parent links): a subagent is a session of its own `<parent>:<agentId>`, lane
  `subagent`, `lane_detail {subagent_type, role}`, `parent_session_id` = the parent; `raw.sessionId` stays the parent's so
  `session_env` lookups are unchanged and `(source, source_id)` dedup is untouched. A tree's share is the sum over a session and
  its children. Effort is `records.effort` per request and `sessions.effort` = the first request's. `FACTORY_ROLE` beats
  `USAGE_LANE` (the runner sets `wave` on every pane): mother/wave→`wave_mother`, lead, worker (`fan_worker` under `USAGE_LANE=fan`),
  mechanical→`worker`; no lane added, so the CHECK is unchanged. Role is also on a subagent's detail (the tree's role).
- **Data found:** effort is a top-level field of every assistant line (main and subagent). Subagent lines carry `isSidechain`,
  `agentId`, the parent's `sessionId` and (97.6 %) `attributionAgent`; the rest take `agent-<id>.meta.json`'s `agentType`.
- **Proof (live, `shared`):** last 30 days, claude-code: effort set on all but 4,597 of 302k records (the lines that carry none);
  3,387 subagent sessions, all 3,387 linked to a parent, 25 type `unknown`; subagent is the largest lane by cost ($4.7k of
  $16.5k). `stats --by role|subagent_type|effort` works. `reprice --dry-run` after the restamp: 819,699 rows scanned, everything
  matches the current prices (the restamp rewrote 318,648 claude-code rows, attribution only; cost totals moved only by
  the 211 rows the 15-min agent had not ingested yet).
- **Factory role history:** `session_env.factory_role` exists only from the hook change on (2026-10-30), so history has no
  role (`stats --by role`: 6 live `wave` sessions so far, everything older `(none)`). Wave 2's FL4 measurement by role has data
  only from sessions started after this wave; say so in the report or wait for a few days of factory runs. Roles reach `usage`
  per host when that host's dotfiles are current (the MacBook included).
- **Tools:** `make restamp-claude-code` (`uninstall-agent` first, `deploy` after; refuses while the agent is loaded) re-scans
  through the normal writer and recomputes claude-code session spans from their records (2 changed, 5 sessions have no records left).
  It aborted after the scan on the first run (the MacBook was unreachable and I had made that note fatal): fixed to a warning; the
  span repair and the cost check were then run by hand.
- **Known limits (reviewer findings not fixed):** a sidecar `meta.json` or mirror hook log that arrives after its transcript was
  consumed leaves `unknown` / no role until the next restamp (the mirror rsync now carries `*.meta.json`); a role that reaches a
  session after its first batch fills `lane_detail.role` but does not move its lane; an older retained hook-log line can shadow a
  newer stored role in memory (pre-existing `loadSessionEnvs` design, `seen_at` of the stored row is not loaded); the iumac mirror
  was unreachable during the restamp, so MacBook transcripts were re-stamped from the mirror as last synced.

## Wave 2 — Window share (U5)            <!-- status: active -->
- [ ] The view `usage.session_window_share` per `docs/usage-schema.md` §Window share: consecutive `quota_samples` per
  account, a moved `*_resets_at` starts a fresh interval, each interval's `five_hour_pct` and `seven_day_pct` delta split
  over the sessions with `records` on that account in the interval by `cost_usd`. A migration, with a test on a fixture
  whose expected shares are computed by hand. An index for `records(account, ts)` if the plan needs it (`EXPLAIN` in the
  test or the doc).
- [ ] Proof: for each account over the last 7 days the shares sum to the observed window movement within a stated
  tolerance; the residual (window moved, no records: the MacBook mirror's lag, sessions on a machine not collected) is
  reported, not hidden.
- [ ] `usage-tracker window --by session|lane|role|subagent_type|issue|repo [--days N]`: share of the 5-hour and 7-day
  windows, top N, `--format json|plain` like the other commands.
- [ ] The FL4 measurement: median and p90 7-day share per spawn by factory role and effort over the data so far, written
  to `docs/reports/<date>-role-window-share.md`. This replaces the never-measured per-spawn estimate the factory once had.
**Left behind:**

## Wave 3 — Cost signals: compactions, skills, cache            <!-- status: pending -->
- [ ] The Claude Code collector records compactions per session (the transcript's compaction marker; find it in live
  transcripts first) as a count on the session and the record that carries it.
- [ ] Skill context: each `Skill` tool call (skill name) and its loaded size where the transcript shows it, per session.
  A table or `lane_detail`, decided in `docs/usage-schema.md`; additive migration.
- [ ] Cache hit ratio per session and lane (`cache_read / (input + cache_read + cache_write_5m + cache_write_1h)`), as a
  column in the window-share view or a sibling view, not stored.
- [ ] Re-stamp 30 days for the new fields.
**Left behind:**

## Wave 4 — The weekly report (U6)            <!-- status: pending -->
- [ ] `usage-tracker report weekly [--week <iso>]`: "where the window went", verdict first. Share of the 5-hour and
  7-day windows by lane, factory role, subagent type and skill; cache hit ratio and compactions by lane; the top ten
  sessions by 7-day share with repo and issue; week-over-week deltas. Then **Findings**: each one a measured claim and the
  one change it proposes (a subagent's effort, a skill's size, a role's tier or effort), numbered with a stable id so the
  next week can report its effect. Markdown on stdout; `--format json` for A2.
- [ ] The report is written to `~/.local/share/usage-tracker/reports/<iso-week>.md` every Monday 07:00 by a LaunchAgent
  (the `prices` agent's pattern, `launchd/`), and delivered to the owner through Hermes as a `no_agent` cron job that
  prints the file (hermes-agent `cron/`, the `quota-nudge.py` pattern). The report never contains secrets, hostnames or
  account e-mails.
- [ ] email-gateway's model spend enters `usage` (`argo/docs/usage-reconciliation.md`): its calls write `usage.records`
  through agw's outbox, or route through agw. Pick the smaller change after reading both; email-gateway runs on the VPS,
  so name the path its rows take to `shared`. If it needs a network grant, stop and write it into **Left behind**.
- [ ] One report run by hand for the last full week; its findings listed in **Left behind**.
**Left behind:**

## Wave 5 — The first findings become changes            <!-- status: pending -->
- [ ] For each finding of Wave 4's report: the change, in the repo it belongs to (a skill's size in dotfiles, a
  subagent's effort in its definition, an agw route). A role's tier or effort in `software-factory/config/roles.json` is
  written into **Left behind** for the program lead, not changed here.
- [ ] Each change is recorded with the finding id it answers, so the next report shows the effect (a `findings` table or
  a tracked file the report reads; decided in `docs/usage-schema.md`).
**Left behind:**

## Wave 6 — The effect, a week later            <!-- status: pending -->
Not before seven days after Wave 5's last change.
- [ ] The next weekly report shows each Wave 5 change's effect against its finding id; a change with no effect or a
  worse one is reverted or replaced, said so in the report.
- [ ] `docs/` describe the cost program as it runs; this plan archived; `software-factory/docs/program.md` row U is the
  lead's to close.
**Left behind:**
