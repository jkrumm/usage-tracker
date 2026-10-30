# Usage schema v2 (Postgres)

Target of the usage pipeline (software-factory decisions SF8, U1-U5): schema `usage` in the `shared` database on the
mini, owned by the role `usage`. Wave 1 created the schema and the price machinery. Wave 2 step 1 added the write path
(`src/pg/writer.ts`, `src/pg/session-env.ts`, [Write path](#write-path)); step 2 switched `ingest` and the collectors to
it: cursors and run state live in `collector_state`, the hook-log lines in `session_env`, the quota series, picker
decisions and IU portal report in their tables. The SQLite staging file and the Argo push are gone. Step 3 ported `budget` and `reprice` to
Postgres and retired `src/pricing.ts`: the IU-specific price facts are rows in `price_overrides`
([below](#iu-specific-knowledge-the-writer-and-price_overrides)).

- **Migrations** live in `migrations/pg/NNNN_name.sql` (plain SQL, forward-only, objects schema-qualified). `make pg-migrate`
  (`bun run src/cli.ts pg-migrate`) applies pending files one transaction each under `pg_advisory_lock`, records them in
  `usage.schema_migrations(version, name, checksum, applied_at)` and refuses an applied file whose checksum changed. It
  creates schema `usage` only when absent (in `shared` the role owns it already).
- **Connection:** `USAGE_PG_URL`, never logged. Unset, `src/pg/connect.ts` builds it for role `usage`, database `shared`,
  `127.0.0.1:5432` from `secrets-run read op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD` (never `op`).
- **Tests:** `make check` injects an admin connection (`.env.test.tpl` through `secrets-run`); each Postgres suite creates
  `usage_test_<random>` and drops it. Without secrets-run the suites skip, the reason in their name.

## Tables

All names lower_snake, times `timestamptz`, money and rates `numeric`, raw payloads `jsonb`.

| Table | Purpose | Key |
|-|-|-|
| `records` | one row per billable unit (a message, or a session for session-grain sources) | `UNIQUE (source, source_id)` |
| `sessions` | the session as an entity for every lane | `UNIQUE (source, source_session_id)` |
| `quota_samples` | Max-window readings per account | `PK (account, sampled_at, machine)` |
| `account_picks` | the account picker's decisions | `PK (ts, lane, machine)` |
| `prices` | effective-dated catalog prices per model key | `UNIQUE (model_key, valid_from)` |
| `price_aliases` | usage `model` to catalog key, with how it matched | `model` |
| `price_overrides` | manual corrections | `id` |
| `collector_state` | per-collector cursor and last-run bookkeeping (also `account-picks`, `iu-portal[:<key>]`) | `source` |
| `session_env` | the claude-code hook's `base_url` / `lane` / `account` / `factory_role` / `factory_session` per session id | `session` |
| `session_events` | compactions and skill loads of a session, see [Session events](#session-events-compactions-and-skills-wave-3) | `PK (source, event_id)` |
| `session_signals` | view: per session, token sums, cache hit ratio, compactions, skill calls and chars | |
| `lane_signals` | view: per source, lane and UTC day, the same signals | |
| `iu_portal_cost` | IU's portal cost report, one cell per day, label and heatmap row, per IU key | `PK (iu_key, day, label, row)` |
| `iu_portal_total` | the portal's monthly total per IU key (reconciliation anchor) | `PK (iu_key, month)` |
| `record_duplicates` | the later copy of a call two stores recorded (gateway mirror), see [Duplicates](#duplicates) | `PK (record_id)` |
| `records_unique` | view: `records` without the marked copies; what `budget` and `stats` read | |
| `schema_migrations` | applied files | `version` |

### records

`(source, source_id)` is the identity; **machine is an attribute** (the old three-part key produced $3,081 of duplicates).
Writers upsert on that key.

- Identity and time: `source`, `source_id`, `grain` (`message`|`session`), `ts`, `ingested_at`.
- Links: `session_id` (fk `sessions`), `price_id` (fk `prices`, the row that priced it).
- Model: `model_raw` (verbatim), `model` (normalized, see below).
- Where: `repo` (normalized), `project_raw` (the collector string, verbatim), `workspace` (`work`|`private`).
- Who pays: `billing` (`max` subscription | `api_key` per-token | `unknown`), `account` (Max account id, `max` rows only),
  `api_key` (IU key id, `api_key` rows only), `machine`, `outcome` (`ok`|`error`).
- What ran: `lane`, `lane_detail jsonb`, `effort`, `issue_id`, `run_id`.
- Five token kinds, separate columns: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_5m_tokens`,
  `cache_write_1h_tokens`; plus `reasoning_tokens` (billed at the output rate *in addition* to `output_tokens`) and `duration_ms`.
- Cost: `cost_reported_usd` (provider-stated, verbatim; NULL unless the provider stated a cost, never a placeholder 0),
  `cost_usd` (final), `cost_source` (`reported`|`prices`|`override`|`none`), `raw jsonb`.
- Indexes: `ts`, `(model, ts)`, `session_id`, `repo`, `(account, ts)`, partial `issue_id`.

### sessions

`lane` is the CHECKed set below, `lane_detail jsonb` holds `{subagent_type, role, workflow, step, route, surface, raw}`.
Other columns: `parent_session_id` (self fk, deferrable, so a child may precede its parent inside one transaction),
`account`, `billing`, `api_key`, `machine`, `model`, `effort`, `repo`, `issue_id`, `run_id`, `first_ts`, `last_ts`.
A record carries its own `lane`: a subagent request inside an interactive session is lane `subagent` on the record and
`interactive` on the session.

### Lane vocabulary

`interactive`, `wave_mother`, `lead`, `worker`, `fan_worker`, `subagent`, `hermes`, `iris`, `agw_workflow`, `other`.

`laneFor(sub_tool, source, raw)` in `src/lane.ts` is the one mapping (tested in `src/lane.test.ts`). From today's
SQLite `sub_tool`:

| sub_tool / source | lane | detail |
|-|-|-|
| `interactive`, `desktop`; empty on claude-code, opencode, codex, astra | `interactive` | |
| `wave` | `wave_mother` | the `rd wave` session |
| `fan` | `fan_worker` | the `rd fan` worktree session |
| `fleet` | `worker` | `raw: fleet` (the work-machine fleet) |
| `lead`, `worker` (claude-code) | `lead`, `worker` | |
| `raw.factoryRole` `mother`, `wave` / `lead` / `worker` / `mechanical` | `wave_mother` / `lead` / `worker` (`fan_worker` when the sub_tool is `fan`) / `worker` | `role`: the factory role; beats the sub_tool |
| `agent-gateway:<x>` (claude-code, opencode); any sub_tool of agent-gateway-*, litellm, agent-workflows | `agw_workflow` | `workflow: x`, `step`: the rest of `a:b:c` |
| research-gateway, audio-gateway(-vps), audio-proxy | `agw_workflow` | `workflow`: the source, `step`: sub_tool |
| source hermes | `hermes` | `surface`: slack, cron, cli, ... |
| source iris | `iris` | |
| `raw.subagentType` | `subagent` | `subagent_type`, and `role` of the tree |
| `raw.workflow` / `.step` / `.route` | `agw_workflow` | as given |
| anything else (headless, bg, cron on feuer, chat-turn:*, modelpick strings) | `other` | `raw`: the sub_tool |

Judgment calls: claude-code rows with no lane (230,945, all before the lane hook) are `interactive`, as `entrypointLane`
treats `cli`; `wave` is the wave mother because `rd wave` exports that lane for the chain session; `fleet` is `worker`.
The factory runner exports `USAGE_LANE=wave` on every pane whatever its role, so a session's `FACTORY_ROLE` (from its
`session_env` line, `raw.factoryRole`) decides the lane and the sub_tool only refines `worker` into `fan_worker`. `mechanical`
has no lane of its own (a `worker`; the role keeps the distinction). Sessions without a role keep the older precedence
(`USAGE_LANE`, the agw window, the entrypoint). No lane was added, so the `sessions.lane` CHECK is unchanged.

## Normalization

- **model:** `normalizeModel` (lowercase, provider prefix, `-eu`, dated suffix) then `baseModel` (`src/prices/aliases.ts`)
  strips a context flag: `claude-sonnet-5[1m]` is `claude-sonnet-5`. The alias table carries both spellings anyway.
- **repo** (`normalizeRepo`, `src/repo.ts`): the directory directly under `SourceRoot`, whatever the home dir. Worktrees
  fold in: `<repo>/.claude/worktrees/...` (the first directory wins), siblings `<repo>-w<N>` and `<repo>-w<N>-trial`, and
  the container `<repo>-wt`. Under `IuRoot` the result is `iu/<dir>`, a separate namespace that can never collide with
  `factory.projects`. NULL: bare `SourceRoot`/`IuRoot`, empty, dot-directories (`.hermes-wt`, `.wt`), `IuRoot/worktrees/<name>`
  (names a branch, not a repo), temp paths, and non-path values (`athena-teamchat`, `hermes-agent`, channel names). The raw
  string always stays in `project_raw`. Nothing is renamed: only the directory name is the slug.
- **tokens:** SQLite stores `cache_write_tokens` TOTAL plus `cache_write_1h_tokens` as a SUBSET, so
  `cache_write_5m_tokens = total - 1h`. A source that cannot split reports all of it as 5m.
- **billing:** SQLite `max` -> `max`; `iu` -> `api_key` with `api_key` = `iu_key`; `anthropic-api` -> `api_key`, no key id
  (`api_key` stays NULL: it is not an IU key, and `budget` reads IU keys only, so such rows never count against a cap);
  anything else `unknown`. `account` only on `max` rows, `api_key` only on `api_key` rows.
- **cost:** see Prices. Writers pass `cost_reported_usd` only when the provider stated a cost; a Hermes `reportedEstimatedCostUsd: 0`
  with `costStatus: unknown` is not one.

## Write path

`upsertRecords(sql, source, records, { defaultWorkspace?, now? })` in `src/pg/writer.ts` returns `{ processed, newRows }` and
has the semantics of `db.upsertRecords`, into `records`:

- **Key and idempotence.** `(source, source_id)`; `machine` is `r.machine ?? currentMachine()`. The conflict branch updates only
  when a content column differs (`IS DISTINCT FROM` over every column but `id`), so `ingested_at` (default the database's
  `now()`, or `opts.now`) moves on real change only. A duplicate `source_id` inside one call keeps the last, as sequential
  SQLite upserts did; a `ts` that is not a date is skipped with a warning (`processed` still counts it).
- **Bulk and concurrent.** Chunks of 500 through `jsonb_to_recordset`, one transaction per chunk (sessions, then records), rows
  `ORDER BY` key so overlapping writers lock in the same order. Pure `INSERT ... ON CONFLICT`, no read-modify-write: several
  processes may call it at once. 5,000 rows with sessions take well under 2 s.
- **Columns.** `model_raw` verbatim; `model = baseModel(normalizeModel(raw))`; `repo = normalizeRepo(project)` with `project_raw`
  verbatim; `workspace = r.workspace ?? defaultWorkspace`; billing mapped as in Normalization (`api_key` = `resolveIuKey`, `account`
  = `resolveAccount`, Max rows only); `lane`/`lane_detail` = `laneFor(subTool, source, raw)` on the record; `cache_write_5m =
  total - 1h` (the 1h count is clamped to the total); `effort`/`issue_id`/`run_id` from `raw.effort`/`raw.issueId`/`raw.runId`.
- **Cost is SQL's.** `cost_usd`, `cost_source`, `price_id` come from `usage.compute_cost(...)` at write time (the one pricing
  implementation; the writer prices nothing). `cost_reported_usd` is set only for a finite `authoritativeCostUsd`, and not for
  `IGNORE_REPORTED_COST` models (`sonar`), which price from tokens. A re-write of an unchanged row re-prices it, so a price
  sync that lands later changes `cost_usd`/`price_id` (and `ingested_at`) of rows re-ingested afterwards, which is intended.
- **`reasoningFreeBefore`.** IU billed no `gpt-5.6-terra` reasoning tokens before 2026-10-16T08:55Z (`REASONING_FREE_BEFORE` in
  `writer.ts`). For such a row the column `reasoning_tokens` is written as 0 and the count is kept in `raw.reasoningTokensUnbilled`,
  so `compute_cost` bills the reasoning share only from the cutoff on. Rows from the cutoff on keep their count.
- **Pre-classified input and insert-only (the history backfill).** A record may carry `preclassified: {billing, account, iuKey, machine?}`
  (`WriterRecord`, `src/pg/writer.ts`): the writer takes them verbatim instead of calling `classifyBilling` / `resolveAccount` /
  `resolveIuKey` (account still Max rows only, key still `iu` rows only; `machine: null` stores NULL). `WriteOptions.insertOnly` turns
  the records statement into `ON CONFLICT DO NOTHING` and the sessions statement into a widening upsert (the span takes
  `least`/`greatest`, a NULL attribute is filled by `coalesce`, lane, lane detail and every stored value stay; no parent-link
  updates), for a source whose own writer owns its rows. A session split across insert-only runs therefore converges on the whole
  span. Neither is set on any live collector path. `scripts/backfill-argo.ts` is insert-only for every source by default and
  overwrites only with `--overwrite` (`make backfill-argo OVERWRITE=...`), see AGENTS.md.
- **session_env.** The batch's `raw.sessionId`s are looked up in `usage.session_env` (`readSessionEnv`, one query per chunk) and
  passed to `classifyBilling` (optional `lookupBaseUrl` parameter, default: the hook-log lookup) and `resolveAccount`.
  `upsertSessionEnv` writes the table: `seen_at` is the hook line's own timestamp, the newest line wins (an older one changes
  nothing but fills a NULL lane, account or factory role/session), `base_url` is replaced as given (NULL and `''` are real values: no gateway, a Max
  session), a missing lane, account, role or spawn key never erases a stored one. The hook-log parsing that fills it is `models.ts` (`useStoredSessionEnvs`, `pendingSessionEnvs`); `ingest` writes the lines
the logs added or changed with `upsertSessionEnv` after a collector runs and before its batch is written.

### Sessions

Every record with a session id upserts a `sessions` row and gets `records.session_id`; a record without one gets NULL (no session
is invented). `sessionKey(source, record)` in `src/pg/sessions.ts` is the identity:

|-|-|
| `raw.sessionId` | claude-code, codex, opencode messages |
| `raw.runId` (else `raw.sessionId`) | agent-workflows: the workflow run is the session |
| the part of `source_id` before the first `:` | hermes, feuer (`<session>:<task>:<model>` rows of one session) |
| the row's own `source_id` | any other session-grain row (opencode sessions, modelpick runs) |
| none | litellm, astra, athena-teamchat (and codex error events): no session |

Per session in a batch: `first_ts`/`last_ts` span the records; every attribute (`account`, `billing`, `api_key`, `machine`, `model`,
`effort`, `repo`, `issue_id`, `run_id`) is the first non-null value in time order, non-subagent records first, so no NULL
erases a value. **Lane:** the lane of the earliest non-subagent record. A subagent request inside an interactive session keeps the
session `interactive` (its record is `subagent`); a session seen through subagent records alone is `subagent` until a main
record arrives. Against a stored session the same rules run inside `ON CONFLICT`: the span widens (`least`/`greatest`), a batch
that starts at or before the stored `first_ts` takes precedence for attributes (still without erasing), a later one only fills
gaps, and the lane changes only to a non-subagent lane from an earlier batch or away from `subagent`.

**Parent links:** `parent_session_id` is set from `raw.parentSessionId` when a collector exposes it, resolved to the parent's
`sessions` row after the batch's sessions exist (so a parent in the same batch works); a parent whose records come in a later
chunk of the same `upsertRecords` call is resolved by a final pass over the call's links; an unknown parent leaves it NULL until
a later batch mentions the link again, and a link is never erased. Only claude-code sets `raw.parentSessionId` (below);
Hermes/Feuer sessions have no parent in the data the collector reads, and agent-workflows steps share a run.

**Claude Code attribution (Wave 1 of the cost program).** What the collector puts in `raw`, and what the writer makes of it:

| transcript / hook field | `raw` | lands in |
|-|-|-|
| assistant line `effort` (else `perTurnEffort`), top level of main and subagent lines alike | `effort` | `records.effort`, `sessions.effort` (earliest non-subagent record's) |
| `session_env` line `factory_role` (the factory runner's `FACTORY_ROLE`) | `factoryRole` | the lane via `laneForRole`, `lane_detail.role` |
| `session_env` line `factory_session` (`FACTORY_SESSION`, the spawn key) | `factorySession` | kept in `raw` and `usage.session_env` only |
| subagent line (`isSidechain` + `agentId`): `attributionAgent`, else the sibling `agent-<id>.meta.json`'s `agentType`, else `unknown` | `subagentType` | lane `subagent`, `lane_detail.subagent_type` |
| subagent line: `agentId`, and the parent's `sessionId` | `agentId`, `parentSessionId` | the subagent's own session, `parent_session_id` |

**Re-stamping history** is `make uninstall-agent && make restamp-claude-code && make deploy`: a full re-scan through the normal writer, a fingerprint of every record's cost and billing before and after (the run fails when it differs), and a recompute of every claude-code session's span from its records (subagent requests that moved had widened their parent's). Known limits: a subagent's sidecar or a mirror's hook log that arrives after its transcript was consumed leaves `unknown` / no role until the next restamp, and a role that reaches a session after its first batch fills `lane_detail.role` but does not move the session's lane.

**Decision: a subagent is a session of its own.** `sessionKey` returns `<parent sessionId>:<agentId>` when `raw.agentId` is
set, with lane `subagent`, `lane_detail {subagent_type, role}` (the role of the tree it belongs to), its own `effort` and
`parent_session_id` = the parent. Why: the window share is per spawn (U5, FL4), and a subagent that burns the window must not
vanish into its parent's number or inherit its effort. `raw.sessionId` stays the parent's, so `session_env` (billing, account,
role) is looked up unchanged; `(source, source_id)` dedup is untouched (the request id). A window share per *tree* is the sum
over a session and its children (`parent_session_id`). Nested subagents (`spawnDepth` 2) link to the top-level session: the
transcript does not name the intermediate agent. A session's `effort` is its first request's; the effort of a mid-session
change is on the records. `lane_detail.role` exists only for sessions whose `session_env` line carries `factory_role` (hook
lines before 2026-10-30 do not), so history before the hook change has no role. The hook change (dotfiles `hooks/session-env.ts`) takes effect per host when that host's dotfiles are current; a session started before it never gets a role.

## Window share (headline metric, U5)

Built in `0011_window_share.sql`, rebuilt per window in `0012_window_share_per_window.sql`, views only (nothing stored):

- `usage.window_intervals` — per account and window (`five_hour` | `seven_day`), each pair of consecutive readings *of that window*
  (a reading without the window's pct or `resets_at` is no reading of it, so a gap does not lose the movement across it; per
  `(account, window, sampled_at)` the first complete reading wins, machines collapsed) is an interval `(from_at, to_at]` with `delta_pct`, the points
  the window moved, plus `records_cost` / `records_n` of the account's Max records inside it. Only intervals with
  `delta_pct > 0` are listed. **Same window**: `resets_at` within 60 s of the previous reading (the statusline jitters it by a
  second), `delta = pct - prev pct` floored at 0, `from_at` = the previous reading. **Fresh window** (`resets_at` moved):
  baseline 0, `delta = pct`, and only records after the window's own start (`resets_at` minus 5 h / 7 d, bounded to the
  interval, so several resets between readings are handled) can have caused it; the old window's tail between its last
  reading and its end is unobserved and attributed to nobody. An account's first reading of a window gives no interval.
- `usage.window_attribution` — each interval's `delta_pct` split over the sessions with priced Max records in it, in
  proportion to `cost_usd` (`share_pct`, points of the window: 3.2 = 3.2 % of the 5 h or 7 d window). Per interval the shares
  sum to `delta_pct` exactly. Unpriced records (NULL cost) carry no share.
- `usage.session_window_share` — a session's share = the sum of its attributed deltas, per window
  (`five_hour_pct`, `seven_day_pct`), by `(account, session_id)`. A subagent is a session of its own; a tree's share is the
  sum over a session and its children (`parent_session_id`).

**Residual.** An interval whose `records_cost = 0` moved the window with nothing to blame (the MacBook mirror's lag, a
machine we do not collect, a model without a price). It stays in `window_intervals`, is in no session's share, and
`usage-tracker window` prints it per window (moved, attributed, residual). Last 7 days at deploy (2026-10-30): 1.1 % of the
5 h points and 2.7 % of the 7 d points across the three accounts; per account at most 2.1 % (5 h) and 5.8 % (7 d).

**Limits.** `quota_samples.sampled_at` is `now - min(window ages)` (the collector), so a window observed earlier than its
sibling in the same reading is dated late and its movement can land on later records; nothing in the table says which. The meters move in whole points: a 7-day tick lands in one 15-minute interval and the sessions in the other
intervals get 0, so a single session's 7-day share is noisy and only sums over many sessions (means, lanes, repos) are
trustworthy; the 5 h window ticks more often. Shares are points of *that account's* window and a Max 20x point (`iu`) is
worth several times the dollars of a 5x point: a row summing accounts adds points of different windows (`--account`
cuts it). A cost-weighted split assumes a window moves in proportion to the dollars of the records in it; over the last 7 days
the dollars per 5 h point are stable per account (`me` 1.4, `me2` 1.3, `iu` 4.5–5.1; p10–p90 of 0.95–1.94 for `me`).

**`--days`** keeps the intervals that *end* inside the period, so the first one can reach up to one sampling gap (normally 15 min, longer
while the MacBook sleeps) before the cutoff; rows and the coverage line use the same filter and agree.

**Plan.** `EXPLAIN` of `window_intervals` over 7 days (969 intervals) uses `records_account_ts_idx` (`Index Scan ... Index
Cond: account, ts range`) for the per-interval record lookup and runs in about 0.85 s; no new index.

CLI: `usage-tracker window --by session|lane|role|subagent_type|issue|repo|account [--days N] [--top N] [--account <id>]
[--format json|plain]` (`make window BY=lane`). First measurement by lane, role and effort:
`docs/reports/2026-10-30-role-window-share.md`.

## Session events: compactions and skills (Wave 3)

Built in `0013_session_events.sql`: one table, two views.

**Decision.** Compactions and skill loads are rows of `usage.session_events`, not record attributes and not `lane_detail`. A
compaction boundary line carries no usage, so no record exists for it; a record's `raw` is overwritten by the last line of
its request id, and a Skill call is one of several lines of a request; a skill's size arrives on another line than its call.
Counts per session are derived by a view, never stored on `sessions` or `records`. The plan's "a count on the session and
the record that carries it" is met by `session_signals` (the session) and the event's `ts` (which record it sits between).

`session_events`: `PK (source, event_id)`, `source_session_id` (the `sessions` key, `<session>:<agent>` for a subagent, via
`eventSessionKey`), `kind` (`compaction` | `skill`), `ts`, `name` (skill), `size_chars` (skill), `detail jsonb`
(compaction: `{trigger, preTokens, postTokens, durationMs}`), `ingested_at`. Indexes `(source, source_session_id)` and
`(kind, ts)`. No FK to `sessions`: an event can be written before its session's first record. `event_id` is the boundary
line's `uuid` or the Skill `tool_use` id.

**Claude Code collector** (`src/collectors/claude-code.ts`, `parseEvents`; fields verified on 2.1.3xx transcripts):
- compaction: a `{type:"system", subtype:"compact_boundary"}` line, `compactMetadata` into `detail`.
- skill call: an `assistant` line whose `message.content[]` holds a `tool_use` named `Skill`; `name` = `input.skill`.
  `input.args` is free text and is never read into an event.
- skill size: the `type:"user"`, `isMeta` line carrying `sourceToolUseID` = the call's id and the text
  `Base directory for this skill: ...`; `size_chars` = total length of its text blocks (a bare string also works). About
  13 % of calls have no such line: `size_chars` stays NULL.
- The call and the size are two events with the same `event_id`; `upsertSessionEvents` (`src/pg/events.ts`) merges them
  on conflict (`name`, `size_chars`, `detail` take the present value, `ts` the earlier), in either order, so a size line in a
  later poll completes the row. A row is written only when a merged column differs, so a `--full` re-scan is a no-op and
  `ingested_at` moves on real change only. Events come from the iumac mirror root too.

**Views.**
- `usage.session_signals`, one row per `sessions` row: `session_id, source, source_session_id, lane, account, repo, issue_id,
  effort, parent_session_id, first_ts, last_ts`; `input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
  cache_write_1h_tokens` summed from its records; `cache_hit_ratio` = `cache_read / (input + cache_read + cache_write_5m +
  cache_write_1h)`, NULL when the denominator is 0; `compactions`, `skill_calls`, `skill_chars` (0, never NULL, when none;
  a call without a size adds a call and no chars). A subagent is a session of its own; a tree's figure is the sum over a
  session and its children.
- `usage.lane_signals`, grain `(source, lane, day UTC)`: the same token sums and `cache_hit_ratio` recomputed from the sums
  (never an average of ratios) over the *records* by the record's own lane (a subagent request inside an interactive session
  counts for `subagent`), plus `compactions`, `skill_calls`, `skill_chars` of the events by the lane of their session and
  the event's UTC day. Full join: a lane/day with only events appears with zero tokens and a NULL ratio. An event whose
  session has no row yet is not listed.

**Plan.** Both views read `usage.records_unique`, so the marked gateway-mirror copies count in neither. Synthetic scratch
database (20k sessions, 600k records, 60k events, `ANALYZE`d): `session_signals WHERE last_ts >= now() - 7 days` filters
`sessions` first (1,013 rows), then per session one `records_session_idx` bitmap scan and one `session_events_session_idx`
index scan, so `records` is never scanned whole. The anti join against `record_duplicates` is a hash of the whole (small)
flag table per session: 75 ms with 600 flagged rows, 291 ms with 6,000 (1 %); the cost follows the flag table, not `records`.
`lane_signals` is a rollup: every filter (`day >= ...`) applies after the aggregate, so each read is one pass over `records`
(parallel seq scan, anti join and sort, 0.25 s at 600k rows). That is fine for a weekly report, not for a hot path; no new index.

**Limits.** A compaction counts only if its boundary line reached disk (a session killed mid-compaction leaves none). Only
`Skill` tool calls are events: a skill the user invoked by slash command appears only as a preload in subagent files and is
not counted. `size_chars` is characters of the injected text, tokens are about chars / 4; it is the size of the skill's
first load, not what a later turn re-reads from cache. The bridge-routed and synthetic filters of the record path do not
apply to events. History before this wave gets its events from `make backfill-events`
(`scripts/restamp-claude-code.ts --events-only`): a full scan of the transcripts (null cursor) that discards the records,
writes only `session_events`, never saves the collector's cursor, does not sync the iumac mirror (it reads the mirror as the last ingest left it, at most 15 minutes old; run an `ingest` first when the MacBook was offline) and may run while the ingest LaunchAgent is loaded (the
upsert is idempotent and merges by id); it prints the events seen, written and the per-kind totals. `make
restamp-claude-code` also re-emits events but is for attribution changes only.

## Prices (U3)

No hand-kept prices. `usage.compute_cost(model, ts, input, output, cache_read, cache_write_5m, cache_write_1h[, reasoning,
grain, reported])` and `src/prices/cost.ts` (`costFor`) apply, in this order:

1. provider-reported cost, verbatim (`cost_source = 'reported'`);
2. an override with `supersedes_prices` whose `[valid_from, valid_to)` contains `ts`;
3. the `prices` row of the aliased catalog key in force at `ts` (alias missing: the model string itself is the key). Before
   the model's first row, that first row stands in (a launch price is the best estimate for the first hours);
4. any other override for the model (fills a model the catalog does not price);
5. NULL with `cost_source = 'none'`. **Never $0** for an unknown model.

`usage.price_at(model, ts)` returns the winning schedule (and `in_force = false` for the before-first-row case).
Within a schedule: base rates, then the **tier** whose `above_tokens` the prompt (input + cache read + both writes) exceeds
(message grain only: a session row sums many requests), then **off-peak** rates inside a window, then unpublished cache rates
fall back (read -> input, write 5m -> input, write 1h -> write 5m). Tiers and off-peak replace only the kinds they list.
Windows are UTC `HH:MM-HH:MM`, `[start, end)`, an end not after the start wraps midnight (`10:00-00:00` is 10:00 to midnight,
`00:00-00:00` is all day), weekdays ISO 1-7. The TypeScript and SQL implementations are tested against the same fixtures.

`prices`: rates in USD per 1M tokens as exact decimals (`input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`;
NULL = not published; `input`/`output` are CHECKed `> 0`), `batch jsonb` (informational), `tiers jsonb`, `off_peak jsonb`,
`source` (`litellm`|`openrouter`|`seed-git`), `source_ref` (URL or commit sha), `fetched_at`.

**Sync** (`make prices-sync`, daily 04:20 via `make install-prices-agent`, label `com.jkrumm.usage-tracker-prices`): reads
LiteLLM's `model_prices_and_context_window.json` for the catalog keys our aliases reference (OpenRouter's `/api/v1/models`
for keys written `openrouter:<id>`) and writes a new row, `valid_from = fetch time`, only when a rate, tier or off-peak value
changed. A key that vanished upstream, lost its input/output price, or lost a previously published cache rate is an error
line, keeps the previous row, and makes the run exit 1. Per-token floats become per-1M decimals by shifting the printed
decimal point, so there is no float drift. OpenRouter time-of-day `overrides` map to an off-peak window when they share one
rate set; endpoint-level `input_cache_write_1h` is not fetched (no OpenRouter-sourced alias needs a cache write).

**History** (`make prices-seed-history`, one-off, idempotent): a blobless, history-limited clone of BerriAI/litellm in a temp
dir, the file at the last commit of each UTC day from 2026-04-01, the same only-on-change rule per aliased model,
`valid_from` = commit time, `source = 'seed-git'`, `source_ref` = sha. The clone is killed above 600 MB.

**Aliases** (`src/prices/aliases.ts`, written by sync): `exact`, `suffix` (`[1m]`), `data` (chosen against measured spend),
`manual`. `deepseek-v4.1-flash` (the most-used DeepSeek model here) maps to LiteLLM's first-party `deepseek/deepseek-v4-flash`:
LiteLLM has no `deepseek/` key for 4.1, `coralbricks/deepseek-v4.1-flash` lists input at 0.01 USD/M and OpenRouter's aggregate
`deepseek/deepseek-v4.1-flash` is 0.045/0.50, while IU's gateway measured 0.30/1.20/0.006 (peak) and exactly half off-peak,
which is what the first-party entry and its off-peak windows say. IU's portal stays the cost truth for `billing=api_key`
rows; the catalog price is an estimate there.

Not aliased (cost stays NULL or provider-reported): null model (athena-teamchat, cost reported), `v3`, `pplx-decider-v1-27b`,
`gpt-4o-transcribe` and the other transcribe/TTS models, `<synthetic>`, `flash-v2.5`, `decision-1`, `clef`, `gemma4-agent`
(local, free), `gemini-3.1-flash`, `gemini-3-flash`, `gemini-4-argon`, `deepseek-v4p1-flash`, test strings. `glm-5.1`, `glm-5.2`,
`mimo-v2.5-pro`, `nemotron-*`, `qwen3.7-max`, `gemini-3-pro-preview` and the `gpt-image-*` models have no catalog key either and are priced by
overrides. Aliased models cover 98.3% of rows and 99.9% of recorded
cost.

### IU-specific knowledge: the writer and `price_overrides`

What the retired `src/pricing.ts` encoded that the catalog does not, and where it lives now. `price_overrides` accepts rates,
tiers and off-peak windows; an override replaces the **whole** schedule (restate tiers and windows it should keep), and
`supersedes_prices` makes it beat the catalog inside `[valid_from, valid_to)`.

- **Writer rules** (`src/pg/writer.ts`, not prices): `REASONING_FREE_BEFORE` (IU billed no `gpt-5.6-terra` reasoning tokens
  before 2026-10-16T08:55Z; the column is written 0 and the count kept in `raw.reasoningTokensUnbilled`, which `reprice` therefore
  respects) and `IGNORE_REPORTED_COST` (`sonar`: the vendor's cost includes search fees IU does not pass on, so
  `cost_reported_usd` stays NULL and tokens price it).
- **Migration `0005_price_overrides_iu.sql`**, derived by comparing every `PRICING` entry with the catalog schedule in force on
  2026-10-30 (effective rates after the cache fallbacks, tiers, off-peak). Models the catalog prices identically got no row.
  `valid_from` 2026-01-01 (before the first record), every row carries a `reason` citing the measurement:
  - IU-measured, superseding: `hy3` 0.14/0.58/0.035, `kimi-k2.7-code` 0.95/4.0/0.19 (OpenRouter 0.56/3.1), and without a catalog
    key `glm-5.1`, `glm-5.2`, `mimo-v2.5-pro`, `nvidia-nemotron-3-super-120b-a12b`, `nemotron-3-ultra`, `qwen3.7-max`. Cache
    writes bill as input (column NULL, the fallback agrees); `qwen3.7-max` and the nemotron super model price cache reads at the
    input rate (no caching observed).
  - **DeepSeek is the catalog's again (`0006_drop_deepseek_overrides.sql`).** 0005 also carried `deepseek-v4-pro`,
    `deepseek-v4-flash` and `deepseek-v4.1-flash` (with a 16:30-00:30 UTC window). Measured against the portal over 2026-09-26..10-30
    the catalog schedule fits better (`deepseek-v4.1-flash` 0.96x of the portal vs 1.39x with that window, `deepseek-v4-pro`
    0.89x vs 1.18x; `deepseek-v4-flash` is too thin to fit, 7 days and $2.72), so 0006 deletes the three rows and `reprice`
    moved 46,617 rows. Weekday/weekend off-peak windows come from the catalog and follow its changes.
  - List-price carry-overs that fill a gap and yield to a later catalog entry (`supersedes_prices = false`):
    `gemini-3-pro-preview`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`.
  - Kept on the catalog (identical effective rates): `kimi-k2.6`, `glm-5.3-flash`, `minimax-m3`, `sonar`, the Claude, Gemini 3.5/3.8 and
    GPT-5/6 models. Claude Haiku 5.5 differs only in the 1h cache write (catalog 0.20 / tier 1.00, the published figure; the old
    file billed it at the 5m rate), which is the catalog's to say.
  - `src/prices/iu-overrides.test.ts` prices known pairs to the micro-dollar against costs computed with the old `computeCost`.
- **Not ported:** the `FAMILY_PRICING` tier fallback (an unpriced Claude id is NULL until the catalog prices it) and free local models
  (`gemma4-agent`: an override cannot be 0, so it stays `cost_source = 'none'`). Claude/Gemini via Bedrock/Azure remain list-price
  proxies of unknown accuracy against IU's EU rate.

### Duplicates

Measured against the portal, the audio gateway (and the image gateways behind it) were counted twice: the usage-tracker collector
read the gateway's own log (`audio-gateway`, machine = the host's hardware label, `audio-gateway-vps`) and the gateway also pushed
every call to Argo (`audio-gateway-mini`, `audio-gateway` with machine `mini` or `vps`). The backfill carried both stores, so one
call is two rows with the same key, model and token counts at timestamps milliseconds apart (the push lumps reasoning into
`output_tokens`, the collector keeps it apart, so the rule compares `output + reasoning` and both cache writes as sums).

- **Rule `gateway-mirror`** (`usage.flag_gateway_duplicates()`, migrations 0007, 0008 and 0009): `billing = 'api_key'` rows of the sources
  `audio-gateway`, `audio-gateway-mini`, `audio-gateway-vps`, `image-gen-gateway`, `image-gateway`, from different `(source, machine)`
  stores, same `api_key` and `model`, equal input, output + reasoning, cache read and cache writes (not all zero), at most 10 s
  apart, are one call. The lower id is kept, the others are written to `record_duplicates(record_id, duplicate_of, rule)`.
  **The matching is per store pair (0009):** rows are walked in `(ts, id)` order and a free row takes, from every other store,
  the earliest free later row of the same signature, so a call is one row per store and every row is in exactly one call; a row
  is never both an original and a duplicate, and two identical calls of one store never merge (the interleaved
  `X_a, Y_a, X_b, Y_b` marks exactly two rows; 0007/0008 paired `b -> min(a.id)` and marked three). A call recorded by three
  stores keeps one row and marks two (22 gpt-image calls, $0.86 of marks that a strict one-pair-per-row rule would drop). Rows already in a pair are skipped, so the function
  is idempotent; `scripts/backfill-argo.ts` runs it after its write loop. 2,278 rows, $72.34 (2026-10: $31.2) on the personal
  key, the same rows before and after 0009 (13 rows only changed which row of their call is named as the original). All of
  them are retired sources.
- **Nothing is deleted.** `usage.records_unique` is `records` without the marked rows; `budget` and `stats` read it, `sources`/`health`
  count raw rows. Undo: `DELETE FROM usage.record_duplicates`. Other readers of `usage.records` (the dashboard) must read the view to
  agree with the portal.
- **Not duplicates:** the scan of every `api_key` pair (same key and model, identical token counts, within 10 s, different source or
  machine) found only this family. Between `agent-workflows` and the collectors (`athena-teamchat`, `agent-gateway-*`, `opencode`,
  `claude-code`, `hermes`, `research-gateway`) it found none: see `docs/reconciliation/2026-10-30-portal-actuals.md`.
- **One writer per call.** A call made by an agent-workflows step is recorded by agent-workflows only. A collector must never read a
  store that agent-workflows workers write (its OpenCode state lives in `~/.local/state/agent-workflows/opencode/`, not in the
  `opencode` collector's `~/.local/share/opencode/`). `athena-teamchat` rows carry no model, so the overlap check for the team key is
  the per-model tie-out against the portal (agent-workflows alone reaches the portal figure for every model it names).

`reprice` (`make reprice [MODEL=] [DRYRUN=1]`) re-applies `compute_cost` to stored rows in one `UPDATE ... FROM LATERAL`: rows with
`cost_reported_usd` are never touched, a priced row whose model has no price today is kept, `ingested_at` is not moved.

**Costs that changed in Wave 2.** History is not repriced, with three exceptions. The backfill priced every row through
`usage.prices` (catalog plus overrides), not the retired `src/pricing.ts`; migration 0006 repriced 46,617 DeepSeek rows; and 4,217
rows ($69.65 in the old store, e.g. `v3` ElevenLabs without token counts) now carry NULL cost, `cost_source = 'none'`, because no price
exists. `cost_reported_usd` is verbatim. The previous costs stay readable in the SQLite archive `~/.local/share/usage-tracker/usage.db`
and in the untouched VPS table `argo.usage_record`.
