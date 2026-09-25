# usage-tracker — collector internals and gotchas

*Moved out of the README to keep that file onboarding-only. Source-specific*
*mechanics, retired-source history and the sharp edges each collector hit.*

## Source-specific notes

### Claude Code billing classification

The `claude-code` collector keeps every assistant row, whatever the model id —
a `ca glm-5.3-flash` session or a sideclaw `iu` worker on DeepSeek leaves the
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
days), and `getSessionBaseUrl()` joins a record's `sessionId` against that log —
a non-empty `base_url` means `iu`, empty means `max`. When the line is missing
(expired, or older than the hook) the id decides the only way it can: Max serves
nothing but bare `claude-*` ids, so a non-Anthropic or `-eu` id is `iu` and a
bare Claude id defaults to `max` (going-forward correctness matters here, not
historical precision).

The `-eu` suffix (`claude-sonnet-4-6-eu`) is the IU gateway's EU-routed twin of
a Claude model, same rate card — `normalizeModel` keeps stripping it because it
is still live: Hermes fails over to it under throttling.

Backgrounded subagents (the TUI's "Backgrounded agent") don't write into the
parent's flat transcript file at all — Claude Code gives them their own file
under `<project-dir>/<sessionId>/subagents/agent-<id>.jsonl`, same `sessionId`
inside. `listJsonl()` in `src/collectors/claude-code.ts` walks into every
session directory's `subagents/` subfolder to pick these up too; skipping this
silently dropped an entire category of usage (1069 historical files, 207MB,
across all projects before this was added — backfilled by the next `ingest`
run automatically, no `--full` needed since those files had never been seen).

Run `billing-audit` (`make billing-audit`) to verify this end to end: it
groups `usage_record` by session, lists every distinct model and billing value
seen in that session (more than one distinct `billing` per session should
never happen — flagged as `MULTI-BILLING`), and cross-checks the stored
`billing` against a live re-read of the `session_env` log, flagging
`MISMATCH` when they disagree (only meaningful while the log is still inside
its 3-day retention window).

### MacBook (iumac) mirror

The `claude-code` collector walks two roots, not one: this machine's own
`~/.claude/projects`, and a local rsync mirror of the owner's MacBook
(`~/.claude/projects` + `~/.claude/logs` over the `iumac` ssh alias). It's
still a single collector and a single `source = "claude-code"` — a second
collector sharing that name would collide on its `collector_state` cursor row,
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
  `machine` unset so `upsertRecords` stamps the local host as usual.
- **Graceful degradation**: a dead or asleep MacBook never blocks or errors
  the collector. `syncIumac()` never throws; a failed sync is logged as a
  warning and the run still ingests whatever the local root has. The run is
  only reported `skipped` (with the sync failure as its note) when *neither*
  root produced a single record — if local records came in, the run is `ok`
  and the failure only reaches the log.
- **Trust boundary**: this is the first source of cross-host data in the
  pipeline — every prior row originated on this machine, but a mirrored row's
  transcript fields and `machine` label were produced on iumac and reached the
  DB over ssh/rsync into a mirror this tracker treats as trusted input. Those
  rows sync onward to Argo like any other row. Accepted as part of
  consolidating both machines' usage into one view, not treated as a problem.
- **Historical billing caveat**: `classifyBilling()` (see above) now scans the
  mirrored `<mirror>/logs` alongside the local `session_env` log, so
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
additive (`pricing.ts` bills input + output + cacheRead + cacheWrite +
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

`pricing.ts` does express OpenAI's long-context surcharge (`long` on a `Rate`,
currently `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol` and `gpt-6-astra`) —
2x input, 1.5x output once a single prompt's input + cacheRead + cacheWrite
passes 272k. `computeCost` only evaluates it for `grain === 'message'`, though:
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

### modelpick benchmark spend (`modelpick`)

`~/SourceRoot/modelpick/modelpick.db` records real spend that otherwise never
reaches Argo: its bench harness points `CLAUDE_CONFIG_DIR` at a scratch dir it
wipes after every run, so no Claude Code transcript — or any other collector's
source of truth — ever sees it (verified: $37.50 across 370 runs, 2026-08-31 →
2026-09-04, invisible until this collector).

`bench_run` is the harness's own ledger, one row per (suite, model, task,
attempt) it ran; the collector reads it directly with `bun:sqlite` (no FTS5
trap here, unlike Hermes/Feuer). One row is a full agent loop, so `grain` is
`'session'`. `cache_creation_tokens` maps to `cacheWriteTokens` and
`thinking_tokens` to `reasoningTokens`; `bench_run.cost_usd` — the harness's own
figure — is carried through in `raw.bench_cost_usd` for comparison only,
because collectors never price (see the module comment atop `pricing.ts`):
tokens are passed through and `computeCost` derives cost like every other
source. `capability_probe`, a separate table in the same DB, is deliberately
never read — it has no token columns at all, so its spend can't be
reconstructed. Watermarked on `bench_run.id` (autoincrement, monotonic), since
unlike Hermes/Feuer/OpenCode's small mutable tables, a finished benchmark
attempt never changes after it's written. Mini-only: `available()` fails
closed when the DB is absent.

### Astra one-shot calls (`astra`)

`astra` (dotfiles' `astra.sh`) is a one-shot OpenAI Responses call —
`gpt-6-astra`, `reasoning.mode=pro`, effort `xhigh` — the highest per-call cost
in the estate. It isn't a Codex session (no rollout JSONL) and doesn't go
through sideclaw's IU transport either, so nothing else here ever sees it.
`astra.sh` appends one JSON object per call to
`~/.local/share/usage-tracker/astra.jsonl`
(`{ ts, request_id, model, input_tokens, output_tokens, reasoning_tokens,
cached_tokens, effort, mode, outcome, duration_ms }`); the collector's
byte-offset jsonl read started as a clone of `sideclaw-iu`'s single-file
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
one-shot jsonl logs (e.g. `sideclaw-iu.jsonl`) this collector must not
swallow. Mirror rows carry the MacBook's `machine` label the same way
claude-code's/codex's do; a failed usage-jsonl-mirror sync never blocks local
ingest and never flips claude-code's own `ok`/`note` (its own
`SyncResult.usageJsonlOk` flag, logged on failure but otherwise silent).

### Sideclaw direct IU calls (`sideclaw-iu`)

sideclaw's multimodal tools (`read_image`, `read_drawing`; `generate_image` was
retired 2026-07, historical rows stay queryable) and the `review` adversary
critic call the IU OpenAI transport with plain `fetch` — no `claude -p`
session, so no transcript. sideclaw's `recordIuUsage` appends one line per
request to `~/.local/share/usage-tracker/sideclaw-iu.jsonl`
(`{ ts, request_id, tool, model, input_tokens, output_tokens, reasoning_tokens,
cache_read_tokens, cache_write_tokens, cost_usd, outcome, latency_ms, bytes }`;
the last four added 2026-09-25, older rows lack them and are treated as
0/null/"ok"); the collector reads it by byte offset and maps `tool` to
`sub_tool`. Billing is derived centrally (always `iu`), the line's own
`billing` field is ignored. A numeric `cost_usd` is the gateway's own reported
cost and is stored verbatim as the row's cost (`cost_source = "reported"`),
taking precedence over this table's pricing.

### research-gateway (`research-gateway`)

research-gateway appends one line per usage record to
`~/.local/share/usage-tracker/research-gateway.jsonl` — its argo usage record
verbatim, the same directory and append-only shape as sideclaw's
`sideclaw-iu.jsonl`, so the collector reads it by byte offset the same way.
`source_id` is the dedup key (`<jobId>:lead`, `<jobId>:worker`, `<jobId>:sonar`,
`<jobId>:tavily`, … or the fixed `tavily-account`); the `tavily-account` snapshot
is re-sent, and because upsert is keyed on `(source, source_id)` the last line
wins, exactly like a session whose token counts grew.

The line's `billing` and `machine` are ignored: billing is derived centrally
(always `iu` here) and `machine` is stamped by `upsertRecords` from
`machine.ts`, not taken from the line's `"mini"`. `sub_tool`, `outcome` (with a
non-`ok`/`error` original kept as `raw.rawOutcome`) and `raw` pass through.

Cost is the one thing split by row. A row with a `model` (the `lead`/`worker`
LLM calls, e.g. `deepseek-v4.1-flash`) is priced from its tokens by the central
table — the line's own `cost_usd` is never trusted. A `cost_source:"reported"`
row (`sonar`, the vendor's own per-call bill, which has no table rate) keeps
the line's `cost_usd` by carrying it on `UsageRecord.authoritativeCostUsd`,
which `upsertRecords` stores with `cost_source = "reported"` and `reprice`
leaves untouched. A row with no model and `cost_source:"none"` stays null.

The collector also recovers from a truncated or rotated file: when the file is
shorter than the persisted offset it resumes from the top instead of stalling
past EOF (safe because the upsert is idempotent). The other offset collectors
still simply hold their offset in that case.

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

### Sideclaw attribution

The bridge logger sees only tokens — it has no way to know which sideclaw tool
(`check`, `review`, `research`, `implement`, …) caused a given request. To
recover that, sideclaw's `runSession` appends one record per worker to
`~/.local/share/usage-tracker/sideclaw-sessions.jsonl` with
`{ tool, project, tsStart, tsEnd, outcome, durationMs, turns }`. The litellm
collector loads this on every run and tags rows whose `ts` falls inside a
window with `sub_tool` and `project`. When concurrent windows overlap, the
narrowest one wins (best-effort heuristic — small risk of misattribution under
heavy parallel fan-out). Review's three internal phases are tagged separately
as `review:router` / `review:angle` / `review:synthesis`.

`claude-code.ts`'s `stampLane()` uses the same log for the identical reason,
via `getSideclawLane()` in `models.ts`, but only when a session has no
`session_env` line at all: sideclaw's own `session_env` write (since
`disableAllHooks` skips the real SessionStart hook) has carried `lane`
alongside `base_url` since 2026-09-24, so a going-forward sideclaw worker
resolves its lane straight from `getSessionLane()` like any other spawner-set
`USAGE_LANE`. This fallback only matters for a pruned or pre-fix line; it is
never used when a line exists but its lane is null, which would otherwise
mislabel a plain manual session that happens to overlap a sideclaw window in
time. The fallback additionally prefers a window whose `project` matches the
claude-code row's own `cwd` over the narrowest-window heuristic above —
claude-code rows carry a cwd, litellm rows don't.

Group by it with `make stats BY=sub_tool`.

### Bridge error rate

Kimi-K2.6 is single-backend (Azure Sweden) and intermittently 5xx/429s, so its
error rate is a property of the *bridge*, not of any one consumer — every source
routed through it (Hermes, sideclaw, OpenCode, …) sees the same rate. Rather than
attribute it per source, the logger's `async_log_failure_event` writes a
token-less `event: "error"` line whenever a request fails, and the collector
ingests those as `outcome = 'error'` rows. A failed attempt the fallback later
rescues still logs (the rescue is a separate success on `claude-sonnet-4-6-eu`),
which is the correct signal for Kimi availability.

`stats` counts only successful rows (`outcome = 'ok'`) so the error rows never
dilute token/cost totals; the error rate surfaces in `make sources` as `err%`.

### Machine attribution

The DB is local per machine; the eventual Argo sync merges several laptops' DBs
into one view. So every row is tagged at ingest time with the host that produced
it. For almost every collector the label is derived once per *batch* (run) from
`currentMachine()`: `USAGE_MACHINE` if set, else the macOS hardware model +
chip via `system_profiler` (e.g. `Mac mini (M2 Pro)`), falling back to the
hostname.

`claude-code` is the one exception: since it spans two hosts in a single run
(this machine + the iumac mirror, see "MacBook (iumac) mirror" above), the
label is set *per record* instead — `UsageRecord.machine` on the record wins
over the batch-derived `currentMachine()` when present (`upsertRecords` in
`db.ts` does `r.machine ?? batchMachine`), so mirrored rows carry the MacBook's
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

