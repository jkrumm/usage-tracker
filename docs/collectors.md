# usage-tracker — collector internals and gotchas

*Source-specific mechanics, retired-source history and the sharp edges each collector hit. Every collector*
*emits `UsageRecord`s; `ingest` writes them through `src/pg/writer.ts` into the Postgres `usage` schema*
*(`docs/usage-schema.md`) and keeps each collector's cursor in `usage.collector_state`.*

## Source-specific notes

### Claude Code billing classification

The `claude-code` collector keeps every assistant row, whatever the model id —
a `ca <model>` session or an agent-gateway `iu` worker on DeepSeek leaves the
transcript as its only record. (Until 2026-09-07 the collector dropped every
non-`claude-*` and `-eu` row, assuming the LiteLLM bridge had logged it; with
the bridge gone that silently lost ~3.7k `glm-5.3-flash` rows in one week.) The
one remaining guard is historical: rows before `LITELLM_BRIDGE_CUTOFF`
(`src/models.ts`, 2026-07-08 — the bridge log's last real request) with a
bridge-shaped id are still skipped, because the `litellm` source already holds
them and a `--full` backfill would otherwise double-count. `billing = 'unknown'`
never occurs for this source.

Billing never comes from the model name. A bare `claude-*` model can come from
either the `c` (Max) or `ca` (IU-direct) launcher, and that's true for a
subagent as much as the top-level turn: a subagent inherits its parent
session's `ANTHROPIC_BASE_URL` and can run a different model (e.g. `Explore` on
Haiku inside a `ca` session), sharing that session's `sessionId`.
`classifyBilling()` (`src/models.ts`) resolves this with the real signal:
`dotfiles/hooks/notify.ts` logs `{ event: "session_env", session, base_url }`
once per `SessionStart` to `~/.claude/logs/YYYY-MM-DD.jsonl` (pruned after 3
days) and the writer joins a record's `sessionId` against it — a non-empty
`base_url` means `billing = 'api_key'` (IU-paid), empty means `max`.

The join runs through `usage.session_env` (`session`, `base_url`, `lane`, `account`, `factory_role`, `factory_session`, `seen_at`), because terminal
panes outlive the 3-day retention. `runIngest` primes `models.ts` with the whole table
(`useStoredSessionEnvs`); the first lookup (`getSessionLane` in the claude-code / opencode collectors) scans the
local and mirrored log dirs and merges them on top, a log entry winning for the same session (a resume's latest
SessionStart is the truth). The scan stays lazy so it lands after the iumac log mirror is synced. After each
collector and BEFORE its batch is written, `ingest` upserts the lines the logs added or changed
(`pendingSessionEnvs` → `upsertSessionEnv`), so the writer's billing / account lookups, which read the table,
see them; unchanged lines are not rewritten. A stored row with a NULL lane still counts as "line exists". When
there is no line anywhere (never logged, or pruned before it was stored) the id decides the only way it can: Max
serves nothing but bare `claude-*` ids, so a non-Anthropic or `-eu` id is `api_key` and a bare Claude id defaults
to `max`.

**Account (Max iu/me/me2).** The same line carries `account` (the registry id resolved from `CLAUDE_CONFIG_DIR`;
absent on the oldest lines, `a`/`b` before the rename — `parseAccount()` maps those to `iu`/`me` everywhere an id
is read). `records.account` is derived by `resolveAccount()` next to `classifyBilling`, in the writer: a `max` row
takes the `account` its source carried in `raw`, then its session's logged account, else `iu`; `api_key` and every
other non-Max row is NULL. A later line without `account` never erases a stored one (`upsertSessionEnv`).
`billing` is unchanged — account is a separate dimension. Both accounts share one `projects/` and `logs/` dir.
`stats --by account` and `billing-audit` show the split.

`<synthetic>`, the zero-token model id of an API-error row, is the exception to
the id rule: it is not a served id, so it follows the session `base_url` and
defaults to `max`. (Before, it counted as non-`claude*` and billed `iu` inside
Max sessions.)

The `-eu` suffix (`claude-sonnet-4-6-eu`) is the IU gateway's EU-routed twin of
a Claude model, same rate card — `normalizeModel` keeps stripping it because it
is still live: Hermes fails over to it under throttling.

Backgrounded subagents (the TUI's "Backgrounded agent") don't write into the
parent's flat transcript file at all — Claude Code gives them their own file
under `<project-dir>/<sessionId>/subagents/agent-<id>.jsonl`, same `sessionId`
inside, and `isSidechain`, `agentId` and (mostly) `attributionAgent` on every line; the collector turns those into a session of
the subagent's own, linked to its parent (`docs/usage-schema.md` §Parent links). `listJsonl()` in `src/collectors/claude-code.ts` walks into every
session directory's `subagents/` subfolder to pick these up too; skipping this
silently dropped an entire category of usage (1069 historical files, 207MB,
across all projects before this was added — backfilled by the next `ingest`
run automatically, no `--full` needed since those files had never been seen).

The collector also emits **session events** (`CollectResult.events` -> `usage.session_events`, `src/pg/events.ts`): a
`compact_boundary` system line is a compaction, a `Skill` tool call is a skill load, and the `isMeta` user line right
after it (`sourceToolUseID` = the call's `tool_use` id, text `Base directory for this skill: ...`) gives its size in
characters. The lines are prefiltered by string before any extra parse; `args` is never read. A call and its size line are
separate events with the same id that merge in the database, so they may land in different polls; a call without a size
line (about 13 %) keeps `size_chars` NULL. Subagent files carry `isSidechain` + `agentId`, so their events belong to
`<sessionId>:<agentId>`. Schema, views and limits: `docs/usage-schema.md` §Session events.

Run `billing-audit` (`make billing-audit`) to verify this end to end: it
groups the claude-code `records` by session, lists every distinct model and billing value
seen in that session (more than one distinct `billing` per session should
never happen — flagged as `MULTI-BILLING`), and cross-checks the stored
`billing` against a live re-read of the hook log, flagging
`MISMATCH` when they disagree (only meaningful while the log is still inside
its 3-day retention window; it reads the live log, not the `usage.session_env` table).

### MacBook (iumac) mirror

The `claude-code` collector walks two roots, not one: this machine's own
`~/.claude/projects`, and a local rsync mirror of the owner's MacBook
(`~/.claude/projects` + `~/.claude/logs` over the `iumac` ssh alias). It's
still a single collector and a single `source = "claude-code"` — a second
collector sharing that name would collide on its `usage.collector_state` cursor row,
and the cursor is a `Record<absolutePath, offset>` anyway, so mirrored files
are simply new keys in the same map. Rows are told apart by the `machine`
column instead (see "Machine attribution" below); every other report
(`billing-audit`, `sourceStatus`, `stats`) keeps working unchanged.

Everything host-specific lives in `src/remote.ts`:

- **Mirror location**: `${USAGE_REMOTE_DIR:-~/.local/share/usage-tracker/remote}/iumac/{projects,logs,codex-sessions,usage-jsonl}/`,
  refreshed by four `rsync -a --delete` runs (`--include=*.jsonl` /
  `--exclude=*`, so each leg only ever pulls jsonl — the `usage-jsonl` leg's
  remote directory also holds a stale, decommissioned `usage.db` (+ WAL/SHM)
  that filter keeps off this machine) at the top of every `collect()`.
- **Env vars**: `USAGE_IUMAC_HOST` (default `iumac`), `USAGE_IUMAC_MACHINE`
  (override the machine label instead of probing for it), `USAGE_REMOTE_DIR`
  (override the mirror root), `USAGE_IUMAC_DISABLE=1` (hard off switch — no
  ssh/rsync call at all).
- **Machine attribution**: mirrored rows get an explicit `machine` (see
  `UsageRecord.machine` in `types.ts`), resolved once per run with precedence
  `USAGE_IUMAC_MACHINE` env > a label cached at `<mirror>/machine` from a
  previous probe > a fresh `system_profiler`-over-ssh probe (cached to disk on
  success) > the literal `"iumac"` if the probe fails. Local rows leave
  `machine` unset so the writer stamps the local host as usual.
- **Graceful degradation**: a dead or asleep MacBook never blocks or errors
  the collector. `syncIumac()` never throws; a failed sync is logged as a
  warning and the run still ingests whatever the local root has. The run is
  only reported `skipped` (with the sync failure as its note) when *neither*
  root produced a single record — if local records came in, the run is `ok`
  and the failure only reaches the log.
- **Trust boundary**: a mirrored row's transcript fields and `machine` label
  were produced on iumac and reached the database over ssh/rsync into a mirror
  this tracker treats as trusted input. Accepted as part of consolidating both
  machines' usage into one view, not treated as a problem.
- **Historical billing caveat**: `classifyBilling()` (see above) now scans the
  mirrored `<mirror>/logs` alongside the local hook log, so
  going-forward MacBook sessions classify correctly. A first backfill will
  still classify most of the MacBook's *historical* sessions as `max` by
  default — `hooks/notify.ts` prunes `session_env` lines after 3 days, so
  those lines are already gone on the source machine by the time the mirror
  first pulls its history. This is a known, accepted limitation, not a bug.

`make ingest-iumac` force-refreshes the mirror and runs the `claude-code`
collector on its own (`ingest --source claude-code`) — useful to check the
mirror without waiting for the next full ingest.

### Codex CLI (`codex`)

The OpenAI Codex CLI, launched by dotfiles' `cx` / `cxa` against the IU unified
endpoint. It writes an append-only rollout JSONL per session under
`~/.codex/sessions/YYYY/MM/DD/`; three line types matter:

| Line | Carries |
|-|-|
| `session_meta` | `session_id`, `cwd` — once, first line |
| `turn_context` | the `model` for that turn |
| `token_usage_record` | `response_id` + the usage delta |

Two traps this collector exists to avoid.

**Cumulative totals sit beside the delta.** Each `token_usage_record` carries
`usage` (this response), `turn_token_usage` and `thread_token_usage` (running
totals). Only `usage` is read — summing a cumulative block multiplies the bill
by the turn count.

**OpenAI nests where Anthropic adds.** `cached_input_tokens` and
`cache_write_input_tokens` are subsets *of* `input_tokens`, and
`reasoning_output_tokens` a subset of `output_tokens`. This table's contract is
additive (`usage.compute_cost` bills input + output + cacheRead + cacheWrite +
reasoning), so the collector subtracts them back out. The five fields then sum
to the vendor's own `total_tokens`, which is the invariant the tests pin.

The model lives on `turn_context`, which can sit before the byte offset a later
run resumes from, so it is carried in the cursor alongside the offset rather
than re-read — otherwise every resumed session would report a null model and
price at nothing.

The sqlite files beside `sessions/` (`state_*`, `thread_history_*`, `logs_*`)
are deliberately not read: `thread_turns` holds no token counts.

Like `claude-code`, this is one collector walking two roots: this machine's own
`~/.codex/sessions`, and a local rsync mirror of the MacBook's (a third
`syncIumac()` leg in `remote.ts`, alongside the existing projects/logs legs —
see "MacBook (iumac) mirror" above). Mirrored rows carry the MacBook's
`machine` label the same way claude-code's do. A failed codex-mirror sync never
blocks local ingest and never flips claude-code's own `ok`/`note` (it has its
own `SyncResult.codexOk` flag, logged on failure but otherwise silent) — the
codex-sessions leg is unrelated to claude-code's transcripts or billing
classification, so folding its failure into that collector's report would
misattribute it.

The price catalog expresses OpenAI's long-context surcharge as a tier (`above_tokens`: 2x input, 1.5x output once a
single prompt's input + cacheRead + cacheWrite passes 272k, on the `gpt-5.6-*` and `gpt-6-astra` models).
`usage.compute_cost` only applies tiers for `grain = 'message'`, though:
the threshold is a per-request concept, but hermes/feuer (and opencode's
legacy session-grain fallback, see below) are session-grain, meaning their
token counts are lifetime sums across every turn in the session, not one
prompt. Applying the surcharge there would price a long-running session as if
it were one giant oversized request and badly overcharge it (a real case: 346
hermes rows overcharged by $16.48, 41% of that model's recorded spend, before
this gate existed). Codex and opencode's default message-grain read are both
grain `'message'`, so their rows correctly get the surcharge when a single
request earns it.

### OpenCode (`opencode`)

Removed 2026-09-04, re-added 2026-09-23 (v1.18.30) — re-verified against the
live schema the same day. `session` still carries the same mutable
per-session totals this collector originally read (the legacy shape below),
but `message` (one row per turn, `data` a JSON blob keyed by `role`) now
carries per-assistant-message tokens/cost too, with its own `modelID`/
`providerID`/`path.cwd`/`time.created`/`time.completed` — strictly finer than
session grain, since a session's cwd or model can change mid-run and session
grain collapses that to one value. Message grain is preferred whenever the
table exists; `sourceId` is the message id, `project` prefers the message's
own `path.cwd` and falls back to the joined session's `directory`. `part` is
never read — token/cost data already lives on the assistant `message` row.

Falls back to the original session-grain read (`sourceId` = session id,
`grain: 'session'`) when `message` doesn't exist (an older OpenCode build),
so the collector degrades gracefully instead of going dark. Both queries
re-read their table whole every run and reconcile by upsert, same as before
the re-add — cheap given the small DB and the 15-min LaunchAgent tick, and
tolerant of a message row updating in place mid-stream.

`subTool` is `getSessionLane(session_id) || "interactive"`: an agent-gateway
dispatch writes a `session_env` line keyed by the `ses_…` id with its lane; no
line means a manual `oc` run or an opencode wave pane, both interactive TUIs.
The fallback must be a string, not null — the table is re-read whole every run,
so a null would make the upsert erase an agent-gateway lane once its log line is
pruned and not yet in `usage.session_env` (only rows since 2026-10-06 still
carry agent-gateway lanes).

### modelpick benchmark spend (`modelpick`)

`~/SourceRoot/modelpick/modelpick.db` records real spend that otherwise never
reaches the usage database: its bench harness points `CLAUDE_CONFIG_DIR` at a scratch dir it
wipes after every run, so no Claude Code transcript — or any other collector's
source of truth — ever sees it (verified: $37.50 across 370 runs, 2026-08-31 →
2026-09-04, invisible until this collector).

`bench_run` is the harness's own ledger, one row per (suite, model, task,
attempt) it ran; the collector reads it directly with `bun:sqlite` (no FTS5
trap here, unlike Hermes/Feuer). One row is a full agent loop, so `grain` is
`'session'`. `cache_creation_tokens` maps to `cacheWriteTokens` and
`thinking_tokens` to `reasoningTokens`; `bench_run.cost_usd` — the harness's own
figure — is carried through in `raw.bench_cost_usd` for comparison only,
because collectors never price: tokens are passed through and
`usage.compute_cost` derives cost like every other source. `capability_probe`, a separate table in the same DB, is deliberately
never read — it has no token columns at all, so its spend can't be
reconstructed. Watermarked on `bench_run.id` (autoincrement, monotonic), since
unlike Hermes/Feuer/OpenCode's small mutable tables, a finished benchmark
attempt never changes after it's written. Mini-only: `available()` fails
closed when the DB is absent.

### Astra one-shot calls (`astra`)

`astra` (dotfiles' `astra.sh`) is a one-shot OpenAI Responses call —
`gpt-6-astra`, `reasoning.mode=pro`, effort `xhigh` — the highest per-call cost
in the estate. It isn't a Codex session (no rollout JSONL) and doesn't go
through a gateway's IU transport either, so nothing else here ever sees it.
`astra.sh` appends one JSON object per call to
`~/.local/share/usage-tracker/astra.jsonl`
(`{ ts, request_id, model, input_tokens, output_tokens, reasoning_tokens,
cached_tokens, effort, mode, outcome, duration_ms }`); the collector's
byte-offset jsonl read started as a single-file
walker, grain `'message'`, `subTool` set to `mode`.

Same Responses-shaped usage object codex.ts already handles: `input_tokens` is
treated as inclusive of `cached_tokens` and the cached amount subtracted back
out (consistent with codex's `cached_input_tokens` handling). Unlike codex,
`reasoning_tokens` is **not** treated as nested inside `output_tokens` — the
logged shape has `reasoning_tokens` exceed `output_tokens` in practice, which
is only possible if the two are already additive in astra.sh's own log format,
unlike a raw vendor payload.

Like `claude-code` and `codex`, this is one collector walking two roots: this
machine's own `~/.local/share/usage-tracker`, and a local rsync mirror of the
MacBook's (the fourth `syncIumac()` leg in `remote.ts` — see "MacBook (iumac)
mirror" above). The cursor is the same per-absolute-path offset map
`codex.ts`/`claude-code.ts` use, not the single-file `{"offset": N}` it
started as; a persisted cursor still in that old shape is migrated in place
(that N becomes the local file's starting offset) rather than dropped, so an
upgrade doesn't force a full re-read. Both roots are walked and filtered to
the `astra.jsonl` basename, since the mirror directory also carries other
one-shot jsonl logs this collector must not
swallow. Mirror rows carry the MacBook's `machine` label the same way
claude-code's/codex's do; a failed usage-jsonl-mirror sync never blocks local
ingest and never flips claude-code's own `ok`/`note` (its own
`SyncResult.usageJsonlOk` flag, logged on failure but otherwise silent).

### email-gateway model calls (`email-gateway`)

email-gateway (VPS) no longer reports to Argo, so its model calls exist only as OTel spans in the VPS ClickStack
(`src/telemetry/llm-call.ts` in email-gateway: span `llm.<lane>`, lane `classify|enrich|draft-reply|thread-summary|jev`;
attributes `llm.model`, `llm.input_tokens` (uncached input), `llm.output_tokens`, `llm.cache_read_tokens`, `outcome`
`ok|error`). The collector reads them from `default.otel_traces` (`ServiceName = 'email-gateway'`, `SpanName LIKE 'llm.%'`)
with the otel skill's transport: keyless `ssh vps "docker exec -i clickstack clickhouse-client --format=JSONEachRow"`, the
SQL on stdin, `BatchMode` and a 90 s hang guard. Nothing changes in email-gateway and nothing is exposed on the network.
The query is injectable (`EmailGatewayQuery`, like athena's); `EMAIL_GATEWAY_SSH` / `EMAIL_GATEWAY_SSH_HOST` override the
binary and host (tests use a fake `ssh`).

One span is one record: `source_id` = `<TraceId>:<SpanId>`, grain `message`, `subTool` = `llm:<lane>`, `model` = `llm.model`,
`durationMs` from the span's `Duration`, `outcome` from the `outcome` attribute or an `Error` status, workspace `private`.
Tokens pass through as recorded; there is no cache write. Spans carry no prompt or output text and none is selected.
Billing, key, lane and cost are the writer's: the source falls through `classifyBilling` to IU, so the rows are
`billing='api_key'`, `api_key='personal'` (the gateway uses the shared `common/anthropic` key), lane `other` with
`lane_detail.raw = 'llm:<lane>'`. A model no price covers (`pplx-decider-v1-27b`) is NULL / `cost_source='none'` and shows
in `make sources`' unpriced list; that is correct, no price or override is added for it.

The cursor is the newest span time seen, JSON `{"newest": ISO}`; each run re-reads one day behind it (upserts are idempotent
on `source_id`). Every read starts no earlier than `HISTORY_FLOOR_MS` (2026-10-24 10:00Z, `--full` included): Argo's backfilled
rows (105, ids are Argo's own) end with the calls of 2026-10-24 09:45, which are also spans, and reading them again would
count those calls twice (it did for two rows, deleted 2026-10-30). A span dated in the future is dropped and cannot move the cursor. An unreachable `ssh vps` or a down ClickHouse throws, so the run records an `error`
for this collector and carries on; an empty result is zero records with no note. `staleAfterHours` is `null`: the gateway makes a
few model calls a month, so any row-age limit would fail `health` on a healthy source or be too loose to mean anything. Silence
is still loud, because a failed read is a collector `error` on every run and `ingest` exits 1 on an error.

### IU portal cost (`iu-portal`, not a `records` source)

IU's own cost report is the only number that counts against the employee cap,
and no API carries it (the gateway answers 501 on every usage/spend path). It is
a Blazor Server page behind Entra/Okta SSO, so the MacBook scrapes it:
`tools/iu-portal/scrape.ts` runs on iumac in headless Chrome (`playwright-core`,
`channel: "chrome"`) against a dedicated persistent profile
(`~/.local/share/iu-portal/profile`). The mini's `collectPortal`
(`src/collectors/iu-portal.ts`) pipes the API key from `secrets-run` into
`ssh iumac 'cd ~/.local/share/iu-portal/tool && bun scrape.ts daily monthly'`;
the key is read from stdin and never touches disk.

- **Heatmap, not bar chart.** `svg.mud-chart-heat` holds one cell per model x
  period (`<title>` = exact USD); row labels sit at cell `y + 4`; columns map in
  x order onto the period labels of the bar chart. `parse.ts` rejects a capture
  whose cell sum is off the "Total Cost" card by more than a cent, which is how
  a half-rendered or stale chart is told from a current one. Never wait for
  `networkidle` (Blazor long-polls).
- **Storage.** `usage.iu_portal_cost(iu_key, day, label, row)`: non-zero cells only, the daily
  report replaces its whole window in one transaction (a vanished cell is deleted, today's value
  grows). Two ids can share a label, hence `row`. `model` is our normalized `records.model`
  when the label's alphanumerics match an IU-billed (`billing = 'api_key'`) model id; NULL = spend we do
  not track. `usage.iu_portal_total(iu_key, month)` is the monthly run, reconciliation only
  (its first period is a partial window and is dropped).
- **Cadence.** One fetch per 4 h per key inside `ingest` (state JSON in `usage.collector_state`
  under `iu-portal` / `iu-portal:<key>`). Unreachable MacBook (ssh 255): skipped quietly, retried
  next run. Expired session (exit 3): logged, backed off 4 h. Neither fails the
  other collectors, and a Postgres error in the portal pass is logged, never fatal to the run. `health` goes stale after 48 h
  without a successful fetch (the later of the state's last success and the newest `fetched_at` in the portal tables).
- **Session expiry** is the one human step: `make iu-portal-login` pushes a
  dialog to the MacBook and runs the headed sign-in (waits up to 5 min).
- **`latest.json`.** Every successful daily scrape also writes
  `~/.local/share/iu-portal/latest.json` on iumac (schema 1: rolling30,
  can-spend-today, 31 daily values, top 10 models, next-7 drop-off), atomically,
  computed on the MacBook so Tinycast keeps working when the mini side is down.
  A failed or expired run leaves the previous file untouched. The mini's
  `collectPortal` writes the same document (same `buildLatest`, `fetched_at` from
  the scrape) to its own `~/.local/share/iu-portal/latest.json` after each
  successful ingest, atomically, dir created; agent-gateway's OCR gate reads it.
  `IU_PORTAL_ROOT` overrides the directory (tests).

### Gateway collectors (retired)

The `agent-gateway-opencode`, `agent-gateway-iu`, `agent-gateway-sessions`, `audio-gateway` and
`audio-gateway-vps` collectors retired 2026-10-29 with the gateways (Wave 11); agent-workflows posts its
own usage to Argo (`source='agent-workflows'`). Historical rows stay in the database; no code
deletes, rewrites or reprices them. What still touches that history is below.

The `research-gateway` collector was removed 2026-10-29: research moved to agent-workflows
(`source='agent-workflows'`, which posts its own rows to Argo) and the MCP was deleted. Its source was silent
from 2026-10-28 15:30Z, the VPS instance since 2026-09-25, and every local row is already in Argo
(`docs/reconciliation/2026-10-29-agent-workflows.md`). The
`research-gateway.jsonl` log is no longer read. Its `sonar` rows are still the reason for
`IGNORE_REPORTED_COST` in `src/pg/writer.ts` (vendor cost ignored, token-priced).

Kept because history still runs over it: the `agent-gateway:*` lanes and the
`agent-gateway-sessions.jsonl` attribution log (`claude-code`/`opencode`/`litellm` re-ingest upserts
the lane, so dropping the join would rewrite old rows), the vendor-`reported`
cost guard in `reprice`, and `classifyBilling`'s `agent-gateway-sessions` branch.

### LiteLLM bridge (retired)

The local LiteLLM proxy and its logger were removed on 2026-09-04; the collector
stays so the rows it ingested remain queryable. What follows describes how those
rows were produced.

The litellm source reads a newline-delimited JSON log written by a LiteLLM
`CustomLogger` callback (`dotfiles/config/litellm/usage_logger.py`) — one line
per request. The collector consumes it by byte offset so it never re-reads
history. If the file is absent the collector reports not-present gracefully.

Each line carries `ts_start` / `ts_end` / `duration_ms`, so the bridge's
per-request latency is queryable directly.

### agent-gateway attribution

The bridge logger sees only tokens — it has no way to know which agent-gateway tool
(`check`, `review`, `research`, `implement`, …) caused a given request. To
recover that, agent-gateway's `runSession` appends one record per worker to
`~/.local/share/usage-tracker/agent-gateway-sessions.jsonl` with
`{ tool, project, tsStart, tsEnd, outcome, durationMs, turns }`. The litellm
collector loads this on every run and tags rows whose `ts` falls inside a
window with `subTool` and `project`. When concurrent windows overlap, the
narrowest one wins (best-effort heuristic — small risk of misattribution under
heavy parallel fan-out). Review's three internal phases are tagged separately
as `review:router` / `review:angle` / `review:synthesis`.

`claude-code.ts`'s `stampLane()` uses the same log for the identical reason,
via `getAgentGatewayLane()` in `models.ts`, but only when a session has no
`session_env` line at all: agent-gateway's own `session_env` write (since
`disableAllHooks` skips the real SessionStart hook) has carried `lane`
alongside `base_url` since 2026-09-24, so a going-forward agent-gateway worker
resolves its lane straight from `getSessionLane()` like any other spawner-set
`USAGE_LANE`. This fallback only matters for a pruned or pre-fix line; it is
never used when a line exists but its lane is null, which would otherwise
mislabel a plain manual session that happens to overlap an agent-gateway window in
time. The fallback additionally prefers a window whose `project` matches the
claude-code row's own `cwd` over the narrowest-window heuristic above —
claude-code rows carry a cwd, litellm rows don't.

After the session lane and the window fallback, `stampLane()` falls back to the
transcript's `entrypoint` (on every line, also kept as `raw.entrypoint`):
`cli` → `interactive`, `sdk-cli` → `headless`, `claude-desktop` → `desktop`,
anything else stays null (`entrypointLane()` in `models.ts`). Precedence is
explicit session lane, then the agent-gateway window, then the entrypoint lane. The
window fallback only runs when there is no `session_env` line *and* the
entrypoint is `sdk-cli` or absent: agent-gateway workers are always `claude -p`, so a
`cli` or `claude-desktop` session can never be one. Without that guard, a
days-old terminal session whose line was pruned got a random `agent-gateway:*` lane from
whichever window its rows overlapped, and lost its `wave`/`fleet` lane.

Group by it with `make stats BY=lane`. `records.lane` is the CHECKed vocabulary `laneFor()` (`src/lane.ts`) derives
from the collector's `subTool` at write time; there is no lane backfill step.

### Bridge error rate

Kimi-K2.6 is single-backend (Azure Sweden) and intermittently 5xx/429s, so its
error rate is a property of the *bridge*, not of any one consumer — every source
routed through it (Hermes, agent-gateway, OpenCode, …) sees the same rate. Rather than
attribute it per source, the logger's `async_log_failure_event` writes a
token-less `event: "error"` line whenever a request fails, and the collector
ingests those as `outcome = 'error'` rows. A failed attempt the fallback later
rescues still logs (the rescue is a separate success on `claude-sonnet-4-6-eu`),
which is the correct signal for Kimi availability.

`stats` counts only successful rows (`outcome = 'ok'`) so the error rows never
dilute token/cost totals; the error rate surfaces in `make sources` as `err%`.

### Machine attribution

One shared database holds the usage of several machines, so every row is tagged
at ingest time with the host that produced it (`machine` is an attribute, not part of the key). For almost every collector the label is derived once per *batch* (run) from
`currentMachine()`: `USAGE_MACHINE` if set, else the macOS hardware model +
chip via `system_profiler` (e.g. `Mac mini (M2 Pro)`), falling back to the
hostname.

`claude-code` is the one exception: since it spans two hosts in a single run
(this machine + the iumac mirror, see "MacBook (iumac) mirror" above), the
label is set *per record* instead — `UsageRecord.machine` on the record wins
over the batch-derived `currentMachine()` when present (`upsertRecords` in
`src/pg/writer.ts` does `r.machine ?? batchMachine`), so mirrored rows carry the MacBook's
label and local rows still fall through to the batch machine. Group by it with
`make stats BY=machine`.

### Feuer access

Hermes and Feuer both run the hermes-agent runtime, so their `state.db` shares
the same `sessions` schema — including an FTS5 `messages_fts` virtual table.
`bun:sqlite` reads Hermes's DB fine but **fails to open Feuer's**
(`unable to open database file`): Feuer's FTS5 schema isn't constructible by
bun's bundled SQLite. The system `sqlite3` (and the container's `python3`) open
both cleanly.

So the host collector reads **out of process** via the system `sqlite3`
(`-json`, read-only) rather than `bun:sqlite` — one uniform path for both
daemons, robust regardless of the FTS5 schema. Setting `FEUER_CONTAINER=<name>`
switches Feuer to a `python3` read inside that container
(`file:/opt/data/state.db?mode=ro`) instead, for when the host bind-mount isn't
reachable. Either way the whole (small, rotating) `sessions` table is re-read
each run and reconciled by upsert — the source rotates old sessions out, so the
tracker stays the durable accumulator.

