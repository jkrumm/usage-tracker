# Gotchas: schema, pricing, billing, attribution

- **The `usage` schema is the contract** (`docs/usage-schema.md`; software-factory decisions SF8, U1-U5). `records` keyed
  `(source, source_id)` with machine as an attribute, five token kinds, `sessions` with the CHECKed lane vocabulary,
  `quota_samples`/`account_picks`, effective-dated `prices`, `collector_state`, `session_env`, `iu_portal_*`. Migrations are
  forward-only and owned here (`make pg-migrate`, `USAGE_PG_URL` or the `usage` role's password via `secrets-run`,
  never `op`); never edit an applied file, add a new one. `usage.compute_cost` (SQL) and `src/prices/cost.ts` must
  agree: change both and the shared fixtures in `src/prices/cost.test.ts` together. An unpriced model is NULL /
  `cost_source='none'`, never 0; `prices-sync` exits 1 on a vanished or zeroed catalog price and keeps the previous row.
  **The writer prices nothing**: `upsertRecords` passes tokens and the reported cost to `usage.compute_cost`. Its two IU
  rules, `IGNORE_REPORTED_COST` (sonar) and `REASONING_FREE_BEFORE` (terra: reasoning written as 0, the count kept in
  `raw.reasoningTokensUnbilled`), live in `writer.ts`. Sessions: id from `sessionKey` (never invented), lane = earliest
  non-subagent record.
- **There is no rate card in code.** Prices are `usage.prices` (catalog, `prices-sync`) plus `usage.price_overrides`:
  migration `0005_price_overrides_iu.sql` holds every IU-measured rate that beats or fills the catalog (the retired
  `pricing.ts` facts; the reason column cites each measurement); DeepSeek is the catalog's, `0006` deleted its three rows
  after the portal fit (`docs/reconciliation/2026-10-30-portal-actuals.md`). An override replaces
  the whole schedule (restate tiers / off-peak), `supersedes_prices` makes it beat the catalog. A new IU rate = a new
  override row with a later `valid_from` in a new migration, never an edit; then `make reprice DRYRUN=1`, then
  `make reprice`. The old `FAMILY_PRICING` tier fallback is gone: an unpriced Claude id is NULL until the catalog
  prices it (`make sources` lists them). Free local models (`gemma4-agent`) stay `cost_source='none'`.
- **Gateway mirror duplicates are marked, not deleted.** The audio/image gateway calls exist twice in `usage.records` (collector
  copy and the gateway's own Argo push); `usage.record_duplicates` marks the later copy (rule `gateway-mirror`,
  `usage.flag_gateway_duplicates()`), `usage.records_unique` is the view without them, `budget` and `stats` read it.
  The matching is per store pair, one row per store per call (migration 0009), idempotent; `backfill-argo` runs it after
  its write loop, so there is no manual step. Agent-workflows is the only writer of its own calls
  (`docs/usage-schema.md` Duplicates).
- **Billing vocabulary:** `billing` is `max` | `api_key` | `api_credit` | `unknown` (migration 0014 added `api_credit`: a request paid
  from a Claude subscription's API credit, written by the agent-workflows inference gateway straight to Postgres with
  `source='gateway'`; it has an `account` but no IU key, is its own `stats --by billing` group, and `budget` never counts it;
  `usage.gateway_picks` is that gateway's table; `usage.credit_cycles` and `usage.platform_cost` are written by the `credit` pass here, its only writer); `stats --by account` splits `iu (max)` from `iu (api_credit)`). Was `max`/`iu`/`anthropic-api`; `anthropic-api` maps to
  `api_key` with a NULL `api_key`, it is not an IU key, and `budget` reads IU keys only, so those rows never count against a
  cap); `account` is set only on `max` and `api_credit` rows, `api_key` (the IU key id) only on `api_key` rows; the CLI dimension `iu_key` is the `api_key`
  column and `lane` replaced `sub_tool`. Never compute cost, billing or lane in a collector.
- **Tool vocabulary** (migration 0021, `docs/usage-schema.md` §Tool vocabulary): `usage.tool_of(source, lane, lane_detail)` is the one
  mapping from a record to Argo's "Tool" dimension (`interactive`, `lead`, `reviewer`, `Explore`, `review`, `research`, `podcast`, `audio`,
  `eval`, `teamchat`, ...), exposed as the `tool` column of `usage.records_unique` and `stats --by tool`. `lane` / `lane_detail` stay
  verbatim (steps and angles remain queryable); a rule change is a new migration with `CREATE OR REPLACE FUNCTION`, nothing is stored.
- **Repo attribution** (`docs/usage-schema.md` §Normalization, §Repair and session evidence): `records.repo` is Argo's "project" dimension and
  comes from `classifyRepo` (path, bare slug, session transcript evidence, source owner, origin/caller, factory workflow), with renames and folds applied
  to every result: **nothing is kept under an old name** (`iu/prometheus-epx` is `iu/epos-ai-teamchat-athena`, `iu/prometheus-scripts` is
  `iu/epos-tool-athena`, ...). `project_raw` and `model_raw` stay verbatim, so a rule change is `make repair FULL=1` (try `DRYRUN=1`
  first: it rolls back and prints the counts and cost per repo). The agw gateway and agent-workflows write straight to Postgres and
  bypass the writer; the repair pass is what classifies them. A new repo directory is known as soon as it exists; a retired real repo
  goes in `RETIRED_REPOS`. `make health` / `make verify` fail on an unknown repo or over 10% NULL-repo tokens in the last 7 days.
  `usage.records_unique` also hides rows before 2026-06-15 (migration 0017, kept in `records`) and the cutover duplicates
  (`usage.flag_cutover_duplicates()`: `hermes` rows after the gateway took over its calls, `agent-workflows` rows whose run the
  gateway reported). The repair also gives the `gateway` source's rows sessions (one `usage.sessions` row per `lane_detail.session`
  key, source `gateway`, rows without a key stay unlinked; stage 2 transcript evidence only selects claude-code sessions). The repair never writes a cost column; `make reprice` is what prices a row whose model it normalized.
- **claude-code attribution** (`raw` from the collector, mapped in `laneFor` / `sessionKey`; detail in `docs/usage-schema.md` §Parent
  links): `raw.effort` (the line's `effort`) → `records.effort`; `raw.factoryRole` (the session's `FACTORY_ROLE` from `session_env`)
  decides the lane (`laneForRole`: it beats `USAGE_LANE`, which the factory runner sets to `wave` on every pane) and lands in
  `lane_detail.role`; a subagent line (`isSidechain` + `agentId`) is a session of its own `<parent>:<agentId>`, lane `subagent`,
  `lane_detail.subagent_type`, `parent_session_id` = the parent. `stats --by role|subagent_type|effort`.
- **claude-code lane precedence** (`stampLane`, `lane` on the record is `laneFor(subTool)`): the session's `USAGE_LANE`
  (from its session_env line), then agent-gateway's time-window fallback — only when no session_env line exists *and* the
  transcript `entrypoint` is `sdk-cli` or absent, since agent-gateway workers are always `claude -p` — then the entrypoint
  lane (`cli` → `interactive`, `sdk-cli` → `headless`, `claude-desktop` → `desktop`). Don't loosen the guard: it stops pruned
  long-lived terminal sessions from picking up random `agent-gateway:*` lanes. opencode rows without a lane are
  `interactive`, never null (the upsert would erase a lane). Lanes are derived at write time; `make restamp-claude-code` re-scans the transcripts so existing rows take a changed attribution (cost fingerprint checked before/after).
- **Session events** (`usage.session_events`, `docs/usage-schema.md` §Session events): compactions (`compact_boundary` lines) and `Skill`
  tool calls with their loaded size, keyed `(source, event_id)` (boundary uuid / `tool_use` id), never record attributes or
  `lane_detail`. A skill's call and its size line are two events with one id, merged by `upsertSessionEvents`, so a size
  arriving in a later poll completes the row; `args` is never stored. Counts and the cache hit ratio are the views
  `session_signals` / `lane_signals` (ratio from sums), nothing stored. Every `tool_use` block is also a `kind='tool'` event (id `tool:<tool_use id>`, tool name only; migration 0024): `session_signals.tool_calls`, which the factory role reads (`SELECT` on the view only). Backfill them with `make backfill-events` (full scan, events only, cursor untouched, safe beside the LaunchAgent); `make restamp-claude-code` is only for attribution changes.
- **session_env** (`usage.session_env`: `base_url`, `lane`, `account`, `factory_role`, `factory_session` per hook session id) outlives the hook's 3-day log
  retention. `ingest` primes `models.ts` with the table, merges the logs on first lookup and writes new or changed
  lines before each batch, so billing / account / lane see them (details: `docs/collectors.md`). `seen_at` is the hook line's
  own `ts`; the newest line wins, an older one only fills a NULL lane or account. `billing-audit` compares
  the stored billing with the live log only.
- **`account` is a dimension, not a billing class.** `records.account` (`iu`|`me`|`me2`; account `iu` ≠ billing `api_key`)
  is set only for `max` and `api_credit` rows. A `max` row takes the source's own `raw.account`, else session_env's `account`, else `iu` (all historical
  lines predate it; legacy `a`/`b` map to `iu`/`me` via `parseAccount`); an `api_credit` row takes only its own `raw.account`, else NULL. Derived in the writer via `resolveAccount`
  (models.ts, the only place that validates the account), never in a collector; a collector must put the session id in
  `raw.sessionId` for the lookup. A NULL Max row is a collector bug and stays visible.
