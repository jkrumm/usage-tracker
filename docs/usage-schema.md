# Usage schema v2 (Postgres)

Target of the usage pipeline (software-factory decisions SF8, U1-U5): schema `usage` in the `shared` database on the
mini, owned by the role `usage`. Wave 1 created the schema and the price machinery. Wave 2 step 1 added the write path
(`src/pg/writer.ts`, `src/pg/session-env.ts`, [Write path](#write-path)); **nothing calls it yet**: `ingest`, `sync` and the
collectors still feed SQLite and Argo until the next step switches them.

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
| `collector_state` | per-collector cursor and last-run bookkeeping (mirrors SQLite) | `source` |
| `session_env` | the claude-code hook's `base_url` / `lane` / `account` per session id | `session` |
| `iu_portal_cost` | IU's portal cost report, one cell per day, label and heatmap row, per IU key | `PK (iu_key, day, label, row)` |
| `iu_portal_total` | the portal's monthly total per IU key (reconciliation anchor) | `PK (iu_key, month)` |
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

`lane` is the CHECKed set below, `lane_detail jsonb` holds `{subagent_type, workflow, step, route, surface, raw}`.
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
| `agent-gateway:<x>` (claude-code, opencode); any sub_tool of agent-gateway-*, litellm, agent-workflows | `agw_workflow` | `workflow: x`, `step`: the rest of `a:b:c` |
| research-gateway, audio-gateway(-vps), audio-proxy | `agw_workflow` | `workflow`: the source, `step`: sub_tool |
| source hermes | `hermes` | `surface`: slack, cron, cli, ... |
| source iris | `iris` | |
| `raw.subagentType` | `subagent` | `subagent_type` |
| `raw.workflow` / `.step` / `.route` | `agw_workflow` | as given |
| anything else (headless, bg, cron on feuer, chat-turn:*, modelpick strings) | `other` | `raw`: the sub_tool |

Judgment calls: claude-code rows with no lane (230,945, all before the lane hook) are `interactive`, as `entrypointLane`
treats `cli`; `wave` is the wave mother because `rd wave` exports that lane for the chain session; `fleet` is `worker`.

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
- **billing:** SQLite `max` -> `max`; `iu` -> `api_key` with `api_key` = `iu_key`; `anthropic-api` -> `api_key`, no key id;
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
- **session_env.** The batch's `raw.sessionId`s are looked up in `usage.session_env` (`readSessionEnv`, one query per chunk) and
  passed to `classifyBilling` (optional `lookupBaseUrl` parameter, default: the SQLite/log-backed lookup) and `resolveAccount`.
  `upsertSessionEnv` writes the table: the newest line wins for `base_url` and `lane`, a missing account never erases a stored
  one. The hook-log parsing that fills it is still `models.ts`'s SQLite store; porting it is a later step.

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
`sessions` row after the batch's sessions exist (so a parent in the same batch works); an unknown parent leaves it NULL until a later
batch mentions the link again, and a link is never erased. **No collector sets `raw.parentSessionId` today**, so nothing is linked:
claude-code subagent requests share their parent's `sessionId` (they stay inside the parent session, lane `subagent` on the record),
Hermes/Feuer sessions have no parent in the data the collector reads, and agent-workflows steps share a run.

## Window share (headline metric, U5)

Between two consecutive `quota_samples` of an account (a sample whose `*_resets_at` moved starts a fresh interval), the change
in `five_hour_pct` and `seven_day_pct` is attributed to the sessions with `records` on that `account` and a `ts` inside the
interval, in proportion to their `cost_usd`. A session's window share is the sum of its attributed deltas; the view is not
built yet, and `records(account, ts)` plus the quota series are its inputs.

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
`gpt-4o-transcribe` and the other transcribe/TTS/image models, `<synthetic>`, `flash-v2.5`, `decision-1`, `clef`, `gemma4-agent`
(local, free), `glm-5.1`, `glm-5.2`, `mimo-v2.5-pro`, `nemotron-*`, `qwen3.7-max`, `gemini-3-pro-preview`, `gemini-3.1-flash`,
`gemini-3-flash`, `gemini-4-argon`, `deepseek-v4p1-flash`, test strings. Aliased models cover 98.3% of rows and 99.9% of recorded
cost.

### IU-specific knowledge: ported to the writer, and still to be expressed as overrides

`reasoningFreeBefore` and `IGNORE_REPORTED_COST` now live in the Postgres writer (see Write path); `src/pricing.ts` stays the
SQLite path until the pipeline switch deletes it. What follows is what `pricing.ts` encodes and the catalog does not.

`price_overrides` accepts rates, tiers and off-peak windows, with `supersedes_prices` for a model whose measured IU rate beats
the catalog. These are the IU-specific facts `pricing.ts` encodes that the catalog does not:

- `reasoningFreeBefore` (done in the writer): IU billed no reasoning tokens for `gpt-5.6-terra` before 2026-10-16T08:55Z; the
  writer zeroes `reasoning_tokens` for such rows and keeps the count in `raw.reasoningTokensUnbilled`.
- `IGNORE_REPORTED_COST` (`sonar`; done in the writer): the vendor's reported cost includes search fees IU does not pass on; the
  writer leaves `cost_reported_usd` NULL for it so tokens price it.
- IU-measured rates that differ from list: `deepseek-v4-pro` 1.32/3.96/0.044, `deepseek-v4-flash` 0.44/1.32/0.014 (the catalog
  now says 0.30/1.20), `kimi-k2.6` 0.95/4.0/0.16, `kimi-k2.7-code` 0.95/4.0/0.19 (OpenRouter: 0.56/3.1), `glm-5.1`/`glm-5.2`
  1.4/4.4, `mimo-v2.5-pro`, `nemotron-*`, `qwen3.7-max`, `hy3` 0.14/0.58/0.035, and the convention `cache_write = input` for the
  Requesty-routed models (here: an unpublished write rate falls back to input, which agrees).
- DeepSeek off-peak window: `pricing.ts` assumes 16:30-00:30 UTC daily; the catalog says weekdays 00-01, 04-06 and 10-24 UTC plus
  all weekend. Both agree on the two measurements taken (06:46Z peak, 17:17Z and ~18:50Z off-peak).
- Claude/Gemini via Bedrock/Azure: list-price proxies of unknown accuracy against IU's EU rate; the family fallback
  (`FAMILY_PRICING`) is not ported, an unpriced Claude id is NULL until the next sync prices it.
- `gemma4-agent` and other free local models: an override cannot be 0 (CHECK); keep them `cost_source = 'none'` or write a
  provider-reported 0.
