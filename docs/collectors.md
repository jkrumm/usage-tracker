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

- **Mirror location**: `${USAGE_REMOTE_DIR:-~/.local/share/usage-tracker/remote}/iumac/{projects,logs}/`,
  refreshed by two `rsync -a --delete` runs (transcripts/logs only, via
  `--include=*.jsonl`) at the top of every `collect()`.
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

One known gap: it is **local only** — there is no iumac mirror, so codex runs on
the MacBook are invisible until one is added (mirror the rsync in `remote.ts`).

`pricing.ts` does express OpenAI's long-context surcharge (`long` on a `Rate`,
currently `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol` and `gpt-6-astra`) —
2x input, 1.5x output once a single prompt's input + cacheRead + cacheWrite
passes 272k. `computeCost` only evaluates it for `grain === 'message'`, though:
the threshold is a per-request concept, but hermes/feuer/opencode are
session-grain, meaning their token counts are lifetime sums across every turn
in the session, not one prompt. Applying the surcharge there would price a
long-running session as if it were one giant oversized request and badly
overcharge it (a real case: 346 hermes rows overcharged by $16.48, 41% of that
model's recorded spend, before this gate existed). Codex is grain `'message'`,
so its rows correctly get the surcharge when a single request earns it.

### Sideclaw direct IU calls (`sideclaw-iu`)

sideclaw's multimodal tools (`read_image`, `read_drawing`, `generate_image`) and
the `review` adversary critic call the IU OpenAI transport with plain `fetch` —
no `claude -p` session, so no transcript. sideclaw's `recordIuUsage` appends one
line per request to `~/.local/share/usage-tracker/sideclaw-iu.jsonl`
(`{ ts, request_id, tool, model, input_tokens, output_tokens, reasoning_tokens,
latency_ms, bytes }`); the collector reads it by byte offset and maps `tool` to
`sub_tool`. Billing is derived centrally (always `iu`), the line's own
`billing` field is ignored.

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

