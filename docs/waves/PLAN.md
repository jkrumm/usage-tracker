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

## Wave 2 — Window share (U5)            <!-- status: done -->
- [x] The view `usage.session_window_share` per `docs/usage-schema.md` §Window share: consecutive `quota_samples` per
  account, a moved `*_resets_at` starts a fresh interval, each interval's `five_hour_pct` and `seven_day_pct` delta split
  over the sessions with `records` on that account in the interval by `cost_usd`. A migration, with a test on a fixture
  whose expected shares are computed by hand. An index for `records(account, ts)` if the plan needs it (`EXPLAIN` in the
  test or the doc).
- [x] Proof: for each account over the last 7 days the shares sum to the observed window movement within a stated
  tolerance; the residual (window moved, no records: the MacBook mirror's lag, sessions on a machine not collected) is
  reported, not hidden.
- [x] `usage-tracker window --by session|lane|role|subagent_type|issue|repo [--days N]`: share of the 5-hour and 7-day
  windows, top N, `--format json|plain` like the other commands.
- [x] The FL4 measurement: median and p90 7-day share per spawn by factory role and effort over the data so far, written
  to `docs/reports/<date>-role-window-share.md`. This replaces the never-measured per-spawn estimate the factory once had.
**Left behind:** shipped to master (`11f64be`, `3c6337c`, `bf77701`, this plan commit), migrations `0011` + `0012` applied, `make deploy`
done, `make verify` green. `make check`: 388 pass, 0 fail, 0 skip. `agw review` ran three times (uncommitted, the fixed tree,
the three commits); the blocking findings that held were fixed, the rest are below.
- **What exists:** views `usage.window_intervals` (per account and window, each interval's `delta_pct` plus the records inside),
  `usage.window_attribution` (interval x session, `share_pct`) and `usage.session_window_share` (account x session, the sum);
  `usage-tracker window --by session|lane|role|subagent_type|issue|repo|account [--days N] [--top N] [--account id] [--format
  json|plain]` (`make window BY=lane`), which also prints moved / attributed / residual per window. `argo` has SELECT on the
  views (default privileges), so A2 can read them. Rule, limits and the `EXPLAIN` (the lookup uses `records_account_ts_idx`, 7
  days in ~0.75 s, no new index): `docs/usage-schema.md` §Window share. 0012 supersedes 0011's view bodies (0011 was applied
  for ten minutes before the review; the checksum rule kept it in place).
- **Proof (live, `shared`, last 7 days, three accounts):** shares sum to the movement minus the residual by construction
  (per interval they equal `delta_pct`). Residual = points in intervals with no priced Max record: 5 h 26.0 of 2,360 (1.1 %),
  7 d 10.0 of 377 (2.7 %); per account at most 2.1 % (5 h) and 5.8 % (7 d, `me2`). Consistency check: dollars per 5 h point are
  stable per account (`me` 1.40, `me2` 1.33, p10-p90 0.95-1.94; `iu` 4.5-5.1, a Max 20x account). The 7 d meter moves in whole
  points, so per-session 7 d shares are noisy and only means over many sessions are trustworthy.
- **FL4 (`docs/reports/2026-10-30-role-window-share.md`):** the factory role cannot be measured yet (6 sessions carry one, all too
  recent), so the table is by lane x model x effort (the lane is the role's stand-in). Model beats effort: Opus spawns cost 2-5x a
  Sonnet spawn in the same lane; a wave mother's 7 d p90 is 2.2-7.7 points and its 5 h p90 13.5-47.7; fan workers' mean is 0.2
  (Sonnet) / 0.9 (Opus); Haiku interactive is 0. Effort cannot be separated from the model in this data (Sonnet runs `high`, Opus
  `medium`; the one cell with both is 6 spawns). Re-run the report's SQL with `GROUP BY role` after a week of factory runs; the
  role-table decision is the program lead's.
- **Known limits (reviewer findings not fixed):** `quota_samples.sampled_at` dates both windows of a reading with the fresher
  one's age, so a window observed earlier is dated late (data limit, documented); a stale reading that moves `resets_at`
  backward counts its pct as a fresh window (also not guarded in 0011); the interval total uses `sum(cost_usd)` over all
  Max records while attribution takes `cost_usd > 0` (no negative cost exists, a check could be added if one appears);
  `--days` keeps intervals that end inside the period, so the first can reach one sampling gap before the cutoff; sessions
  with one local id in different sources are separate rows with the same displayed key; points are per account's window
  (`iu` is Max 20x), so a row spanning accounts adds points of different windows, `--account` cuts it.

## Wave 3 — Cost signals: compactions, skills, cache            <!-- status: done -->
- [x] The Claude Code collector records compactions per session (the transcript's compaction marker; find it in live
  transcripts first) as a count on the session and the record that carries it.
- [x] Skill context: each `Skill` tool call (skill name) and its loaded size where the transcript shows it, per session.
  A table or `lane_detail`, decided in `docs/usage-schema.md`; additive migration.
- [x] Cache hit ratio per session and lane (`cache_read / (input + cache_read + cache_write_5m + cache_write_1h)`), as a
  column in the window-share view or a sibling view, not stored.
- [x] Re-stamp 30 days for the new fields.
**Left behind:** shipped to master (`c18946c`, `f0892b2`, the fix commit, this plan commit), migration `0013` applied, `make deploy`
done, `make verify` green. `make check`: 404 pass, 0 fail, 0 skip. `agw review` ran three times (uncommitted, the fixed tree, the
two commits); the blocking findings that held were fixed, the rest are below.
- **Decision** (`docs/usage-schema.md` §Session events): compactions and skill loads are rows of `usage.session_events`
  `(source, event_id)`, not record attributes. A `compact_boundary` line has no usage, a record's `raw` is overwritten by the last
  line of its request, and a skill's size is on a different line than its call (the two halves merge by `tool_use` id, polls apart).
  Counts are derived, never stored: `usage.session_signals` (per session: token sums, `cache_hit_ratio`, `compactions`,
  `skill_calls`, `skill_chars`) and `usage.lane_signals` (source x lane x UTC day, ratio from sums). Both read `records_unique`.
  `argo` can read them like the Wave 2 views.
- **Transcript facts:** compaction = `type:"system"`, `subtype:"compact_boundary"`, `compactMetadata {trigger, preTokens, postTokens,
  durationMs}` (kept in `detail`). Skill call = `tool_use` `name:"Skill"`, `input.skill` (args are free text, never stored). Skill size
  = the following `isMeta` user line with `sourceToolUseID`, whose text starts `Base directory for this skill`; size is characters
  (tokens ~ chars / 4). 13 % of calls have no such line (size NULL).
- **Tools:** `make backfill-events` (`restamp-claude-code.ts --events-only`) is the way to backfill events: full scan, records
  discarded, cursor untouched, no mirror sync, safe beside the LaunchAgent. Run it after `ingest` when the MacBook was offline.
- **Proof (live, `shared`):** 2,290 events (2026-09-15 on): 2,058 skill calls (1,778 with a size), 232 compactions, none without a
  session. 30 days, claude-code, by lane: `interactive` 103 compactions / 629 skill loads, `fan_worker` 77 / 145, `wave_mother` 35 / 868
  (avg 7.7k chars per load), `subagent` 1 / 329; cache hit ratio 0.96-0.99 in every main lane (`other` 0.67). Skills by loaded size:
  `wave` 483 loads x 11.2k chars, `review` 310 x 5.4k, `investigate` 193 x 6.0k, `epx` 72 x 12.3k, `claude-api` 2 x 114k chars.
  `session_signals` over 7 days (9,895 sessions) reads in 1.3 s; `lane_signals` is a full pass over `records` (fine weekly).
- **Known limits (reviewer findings not fixed):** only `Skill` tool calls count (a slash-invoked skill leaves no call; the 64 such
  loads in the data are subagent preloads); a malformed or out-of-range event line is dropped silently (not logged); a skill marker
  split across two text blocks would lose its size (never seen); the backfill reads the iumac mirror as the last ingest left it;
  `lane_signals` has no date pushdown; a size half that arrives without its call stays a nameless skill event until the call is seen.
- **Found, not fixed (pre-existing, `claude-code.ts` `collectRoot`):** the saved offset is `from + <character index> + 1`, but
  `Bun.file().slice` takes bytes. On a file with multibyte text the offset undershoots (a test line of 529 characters / 1049 bytes twice
  gave 1058 against a size of 2098), so every poll re-reads part of what it consumed and the first line is a partial one that fails to
  parse. No data is lost (idempotent upserts), the cost is wasted re-reads on every multibyte file. A fix is `from +
  Buffer.byteLength(chunk.slice(0, lastNl + 1))`; stored cursors then jump to exact offsets. Not touched here: outside this wave's ask.

## Wave 4 — The weekly report (U6)            <!-- status: done -->
- [x] `usage-tracker report weekly [--week <iso>]`: "where the window went", verdict first. Share of the 5-hour and
  7-day windows by lane, factory role, subagent type and skill; cache hit ratio and compactions by lane; the top ten
  sessions by 7-day share with repo and issue; week-over-week deltas. Then **Findings**: each one a measured claim and the
  one change it proposes (a subagent's effort, a skill's size, a role's tier or effort), numbered with a stable id so the
  next week can report its effect. Markdown on stdout; `--format json` for A2.
- [x] The report is written to `~/.local/share/usage-tracker/reports/<iso-week>.md` every Monday 07:00 by a LaunchAgent
  (the `prices` agent's pattern, `launchd/`), and delivered to the owner through Hermes as a `no_agent` cron job that
  prints the file (hermes-agent `cron/`, the `quota-nudge.py` pattern). The report never contains secrets, hostnames or
  account e-mails.
- [x] email-gateway's model spend enters `usage` (`argo/docs/usage-reconciliation.md`): its calls write `usage.records`
  through agw's outbox, or route through agw. Pick the smaller change after reading both; email-gateway runs on the VPS,
  so name the path its rows take to `shared`. If it needs a network grant, stop and write it into **Left behind**.
- [x] The Claude Code collector's saved offset counts bytes (Wave 3's Left behind, `collectRoot`: a character index fed to
  `Bun.file().slice`), with a test on a multibyte file; stored cursors move to exact offsets without losing a line.
- [x] One report run by hand for the last full week; its findings listed in **Left behind**.
**Left behind:** shipped to master (`6bb27d0`, `bf92a93`, `2485df4`, this plan commit; hermes-agent `67a0779`; email-gateway and argo doc commits), no migration,
`make deploy` and `make install-report-agent` done, `make verify` green. `make check`: 438 pass, 0 fail, 0 skip. `agw review` ran three times
(uncommitted tree each time, after each round of fixes); the blocking findings that held were fixed, the rest are below.
- **The report** (`src/weekly.ts`, `docs/usage-schema.md` §Weekly report): `usage-tracker report weekly [--week 2026-Www] [--format md|json] [--top N] [--out <dir>]`,
  `make report [WEEK=] [FORMAT=] [OUT=1]`. Sections: verdict, window share by lane / role / subagent type (this week, previous, delta), skill loads, cache ratio
  and compactions by lane, top sessions by 7d share, findings, coverage. **Findings** have the id `<rule>:<subject>` (`skill-size:`, `subagent-effort:`,
  `role-tier:`, `compaction-rate:`, `cache-ratio:`), thresholds in `FINDING_THRESHOLDS`; both weeks are recomputed by the same pure rules, so the effect of a
  change is `prev -> now` under the same id, and nothing is stored. A finding the previous week lacked is `new`; one that disappeared is `Resolved`; one whose
  rule could not be measured in either week (no quota readings for that window, no Claude Code records) is `unmeasured` / `unknown`, never "resolved".
  Session counts and per-session means include sessions with no attributed share (0 points).
- **Delivery:** LaunchAgent `com.jkrumm.usage-tracker-report` (`launchd/install-report-agent.sh`, Monday 07:00, `jobrun --every 604800`) writes
  `~/.local/share/usage-tracker/reports/<iso-week>.{md,json}` (0700/0600); Hermes job `825d9e57be32` ("Usage weekly report", no-agent, Mon 07:30, the owner's Hermes Slack channel)
  prints the file (`hermes-agent/scripts/usage-weekly-report.py`; a missing file prints one line saying so). Proven: `launchctl kickstart` wrote `2026-W43.{md,json}`,
  the Hermes script printed it. The first scheduled run is Monday 2026-11-02 (report for 2026-W44; W43 is its previous week).
- **email-gateway:** a collector `email-gateway` reads the gateway's `llm.*` OTel spans from the VPS ClickStack over `ssh vps` (no email-gateway change, no network grant).
  Path to `shared`: ClickStack on the VPS -> `ssh vps docker exec clickstack clickhouse-client` from the mini -> `usage.records` (`billing=api_key`, key `personal`).
  `staleAfterHours: null` (a few calls a month; a failed read is a collector error and `ingest` exits 1). **Mistake caught live:** the 15-min agent runs from the working
  tree, so the collector ingested two spans that Argo's backfill already holds (105 rows end 2026-10-24 09:45); I deleted those two rows and added `HISTORY_FLOOR_MS`
  (every read starts after 2026-10-24 10:00Z). `pplx-decider-v1-27b` stays unpriced (4 rows). 2 calls in 30 days: the spend is negligible, the wiring is what matters.
- **Byte offset:** `collectRoot` reads bytes and splits on `0x0A`. Live after deploy: 9,285 of 9,290 cursor files sit exactly at the file size, 5 (open transcripts) behind, none past the end.
  Old cursors were short of the true offset, so no line was lost.
- **Findings of the by-hand run (`make report WEEK=2026-W43`, the last full week, window data only from 2026-10-24 so it has no previous week):**
  `skill-size:wave` (108 loads x 11.8k chars, 318k tokens in the week; propose trimming below 8k chars in dotfiles); `subagent-effort:implementer` (249 sessions, 16.6 7d points,
  rank 1 of 5, 0.067/session), `subagent-effort:verifier` (46, 2.2, 0.048), `subagent-effort:general-purpose` (179, 1.7, 0.0096); each proposes lowering the definition's effort by one level.
  Subagents are the largest lane (42 % of the attributed 7d points). **Weak signal for Wave 5:** the subagent rule fires on rank, not on impact, and verifier / general-purpose
  cost under 0.05 points a session; only `implementer` and `skill-size:wave` are worth a change. No role finding yet: no session carries a factory role in W43.
- **Wave 5 inherits:** findings have stable ids but no record of the change that answers them. Decide in `docs/usage-schema.md` whether that is a `findings` table or a tracked file
  the report reads (the report would print `change <ref> landed <date>` next to the id). An effort change lands in the subagent definition (dotfiles); the factory role table is the program lead's.
- **Known limits (reviewer findings not fixed):** skill names and repo / subagent labels are shown as they are in the database (skill names pass an allowlist regex, which cannot tell a
  token-shaped name from a real one; no such name exists); the compaction rate's denominator is the sessions active in the week, not also those attributed from before it; a legacy cursor
  replaying a few lines of a file's tail can null a duration whose parent line sits before the offset (the old code did this on every poll, once now); a span reaching ClickStack more than a day
  after a newer one is missed; a nonnumeric token attribute reads as 0; two report files are renamed one after the other, so a crash between the renames mixes generations;
  `make deploy` does not install the report agent (a new host runs both installers).
- **Pre-existing, not mine:** hermes-agent `scripts/check-cron-registry.py` reports five jobs absent from or contradicting `docs/scheduled-jobs.md` (claude-release-watch, Fleet babysitter,
  quota-nudge, Morning briefing / Evening report paused vs registered live); its untracked `scripts/model-release-watch.py` is not committed.

## Wave 5 — The first findings become changes            <!-- status: active -->
Lead's scope (2026-10-30): answer `subagent-effort:implementer` here, and build the record of change ref → finding id.
`skill-size:wave` is answered by F1's retirement, which rewrites `dotfiles/skills/wave/SKILL.md` anyway (the program lead lands
it and gives its commit); do not edit that skill here. `verifier` and `general-purpose` are below the impact bar: no change.
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
