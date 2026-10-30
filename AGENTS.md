# usage-tracker

Token and cost telemetry for every AI tool I run, ingested into the Postgres `usage` schema (database `shared` on
the mini, role `usage`). One normalized `usage.records` table, effective-dated prices in SQL, one CLI. Collectors are
dumb: they emit tokens and ids only. Model normalization, billing classification, lanes, sessions and pricing live
centrally in the writer (`src/pg/writer.ts`, `usage.compute_cost`), so a new source never re-implements them. A
LaunchAgent runs `ingest` every 900 s; the dashboard and APIs read the same schema. There is no staging store and no
push step.

## Layout

- `src/cli.ts` — CLI entrypoint: `ingest`, `stats`, `quota`, `iu-portal`, `budget`, `reprice`, `sources`, `health`,
  `billing-audit`, `window`, `report weekly`, `pg-migrate`, `prices-sync`, `prices-seed-history`.
- `src/ingest.ts` — the pipeline. One `connect()` (`src/pg/connect.ts`), each collector isolated, cursor and run
  bookkeeping in `usage.collector_state` (`src/pg/state.ts`: `loadCursor`, `saveState`, `records_total` = the
  source's row count), records through `upsertRecords`. Also drives the quota / picks / portal passes.
- `src/collectors/<name>.ts` — one file per source, emits `UsageRecord`s; registered in `src/collectors/index.ts`.
- `src/pg/` — `connect.ts`, `migrate.ts`, `cli.ts` (the Postgres commands); `writer.ts` (`upsertRecords`: records,
  sessions, cost via SQL), `sessions.ts`, `session-env.ts`, `state.ts`; `testing.ts` + `fixture.ts` (scratch-database
  harness). Migrations: `migrations/pg/NNNN_name.sql`, `make pg-migrate`. Shape and rules: `docs/usage-schema.md`.
- `src/models.ts` — model normalization, `classifyBilling`, `resolveAccount`, the hook-log `session_env` lookups
  (`getSessionLane`, `useStoredSessionEnvs`, `pendingSessionEnvs`) and the transcript-entrypoint lane map.
- `src/pg/events.ts` — `upsertSessionEvents`: compactions and skill loads (`usage.session_events`, migration 0013; views
  `session_signals` / `lane_signals` hold the cache hit ratio and the counts), emitted by the claude-code collector in
  `CollectResult.events`. See the "Session events" gotcha.
- `src/lane.ts` (`laneFor`), `src/repo.ts` (`normalizeRepo`) — the pure lane and repo mappings the writer calls.
- `src/report.ts` — `stats`, `sources`, `health` staleness, `unpricedByModel`, `billing-audit` over the `usage` schema.
- `src/window.ts` — `window`: the share of the Max 5 h / 7 d windows by session, lane, role, subagent type, issue, repo or
  account over the `usage.window_attribution` / `session_window_share` views (migration 0011; rule and limits in
  `docs/usage-schema.md` §Window share), `make window BY=lane`; the residual (window moved, no priced record) is printed.
- `src/weekly.ts` — `report weekly [--week <iso>] [--format md|json] [--out <dir>]`: "where the window went" for one ISO week
  (verdict, window share by lane / role / subagent type, skill loads, cache ratio and compactions by lane, top sessions,
  numbered **findings** with a stable id `<rule>:<subject>` and their effect against the previous week); `make report`.
  Rules, thresholds and ranges: `docs/usage-schema.md` §Weekly report. `launchd/install-report-agent.sh` runs it Mondays
  07:00 and writes `~/.local/share/usage-tracker/reports/<iso-week>.{md,json}`; Hermes (`usage-weekly-report.py`, 07:30) delivers
  the file. `src/changes.ts` + `docs/finding-changes.json` record which change answers which finding id. See the "Weekly report" gotcha.
- `src/collectors/email-gateway.ts` — email-gateway's model calls, read from its `llm.*` OTel spans in the VPS ClickStack over
  `ssh vps` (`docs/collectors.md`).
- `src/iu-keys.ts` — the registry of IU API keys (`personal`, `athena-team`; ids, op:// refs, cap) and `resolveIuKey`,
  the one place that decides which key an IU row was billed to. See the "IU keys" gotcha.
- `src/collectors/iu-portal.ts`, `tools/iu-portal/` — IU's own cost report (the cap) scraped from the MacBook into
  `usage.iu_portal_cost` / `iu_portal_total`. See the "IU portal cost" gotcha.
- `src/collectors/claude-quota.ts`, `src/collectors/account-picks.ts` — not `records` sources: the Claude Max account
  quota series and the dotfiles picker's decisions (`usage.quota_samples` / `usage.account_picks`).
- `src/collectors/athena-teamchat.ts` — Athena Teamchat's own spend from its Postgres (the team key's).
- `src/prices/` (`normalize.ts`, `cost.ts`, `sync.ts`, `history.ts`, `aliases.ts`, `store.ts`) — the effective-dated
  `usage.prices` table synced daily from LiteLLM (OpenRouter fallback) and the cost resolution that mirrors SQL
  `usage.compute_cost`: `make prices-sync`, `make prices-seed-history` (one-off), `make install-prices-agent` (daily
  04:20, `com.jkrumm.usage-tracker-prices`, separate from the ingest agent).
- `src/budget.ts` — `make budget`: the IU cap report (rolling 30 days per key, portal vs tracked per day and model,
  `--explain <model>`) over `usage.iu_portal_cost` / `iu_portal_total` and `usage.records` (`billing='api_key'`).
- `src/reprice.ts` — `make reprice`: one set-based `UPDATE usage.records ... FROM LATERAL usage.compute_cost(...)`.
- `scripts/backfill-argo.ts` (`make backfill-argo`, `DRYRUN=1`, insert-only unless `OVERWRITE=`), `scripts/backfill-proof.ts`, `src/backfill.ts` — the one-off, re-runnable
  history backfill of Argo's `argo.usage_record` (dumped read-only over ssh into `~/.local/share/usage-tracker/backfill/`) and the SQLite
  archive into `usage.records` / `usage.sessions`; it writes the proof `docs/backfill/<date>-argo-usage-record.md`.
  `scripts/import-sqlite-state.ts` (`make import-sqlite-state`), `src/backfill-state.ts` — the archive's state tables into `usage.*`.
- `launchd/install-agent.sh` — renders and (re)loads the LaunchAgent.
- `docs/collectors.md` — per-collector mechanics and sharp edges.

## Validate

`make check` runs `make typecheck` (`bun run tsc --noEmit`) and then
`bun test` (Bun's runner; `*.test.ts` colocated in `src/`). There is no
separate linter. The targets are side-effect free — every pipeline suite (ingest, collectors, report, health, writer,
prices) creates and drops a `usage_test_<random>` database as the admin role; the few SQLite tests left read scratch
files under `mkdtemp` (the sources' own stores). `make check`/`make test` inject
`USAGE_TEST_PG_URL` from `.env.test.tpl` through `secrets-run`; without it (no secrets-run)
those suites skip with the reason in their name (a green run with skips proves nothing: check the count). No test touches the network.
The Postgres suites use the admin role (`jkrumm`, superuser) on the shared mini server because they must `CREATE`/`DROP`
scratch databases; nothing else needs it. Scratch names are strictly `usage_test_<12 hex>` and `src/pg/testing.ts`
(`assertScratchName`) refuses to create or drop any other name. `ARGS` (`make test ARGS=src/prices`) reaches the shell as an
environment variable, never spliced into the command text.

## Deploy

`make deploy` is a thin alias for `make install-agent`
(`launchd/install-agent.sh`): it renders
`~/Library/LaunchAgents/com.jkrumm.usage-tracker.plist`, then
bootout/bootstrap/kickstart it. The agent runs
`bun run src/cli.ts ingest` every 900s under `jobrun` (dotfiles; `--timeout 600`,
state in `~/.local/state/jobs/`, graded by `jobs-grade`). Re-running the installer is idempotent,
so deploying a merged default branch is just `make deploy`. There is no CI and
no rollback path: revert the offending commit and `make deploy` again. The plist holds no secret: the Postgres URL
is built at spawn by `usagePgUrl()` (role `usage`, password via `secrets-run read`, never `op`; `USAGE_PG_URL`
overrides). Schema changes ship as a new `migrations/pg` file and `make pg-migrate` before the deploy.
`make install-report-agent` installs the separate weekly report agent (`launchd/install-report-agent.sh`, label
`com.jkrumm.usage-tracker-report`, Monday 07:00 under `jobrun --every 604800`; it never reloads the ingest or prices
agents; `make uninstall-report-agent`). `make deploy` does not install it: a new host runs both installers.
`make install-prices-agent` installs the separate daily `prices-sync` agent (`launchd/install-prices-agent.sh`; it never
reloads the ingest agent, and `prices-sync` resolves the Postgres password itself at spawn).

## Verify & Monitor

- Health URL: none — this is a batch LaunchAgent, not a server.
- Kuma monitor: none dedicated; liveness is the `jobs` grade (`jobs-grade --table`),
  relayed by `make doctor` and the `MacMini Dev Host - Push` heartbeat (WARN-only).
- OTel `service.name`: none — the repo emits no OTel.
- `make verify` exits non-zero unless `launchctl print` sees
  `com.jkrumm.usage-tracker`, `~/Library/Logs/usage-tracker.log` is younger
  than 1800s, and `health` finds no stale source (`max(ts)` per source in `usage.records`, plus the IU portal's
  last success). `make health`, `make sources`, `make stats BY=<dim>`, `make quota` read the same schema.
- Logs live in `~/Library/Logs/usage-tracker.{log,err}`; `make logs` tails the
  last 50 lines.

## Gotchas

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
- **Billing vocabulary:** `billing` is `max` | `api_key` | `unknown` (was `max`/`iu`/`anthropic-api`; `anthropic-api` maps to
  `api_key` with a NULL `api_key`, it is not an IU key, and `budget` reads IU keys only, so those rows never count against a
  cap); `account` is set only on `max` rows, `api_key` (the IU key id) only on `api_key` rows; the CLI dimension `iu_key` is the `api_key`
  column and `lane` replaced `sub_tool`. Never compute cost, billing or lane in a collector.
- **Collector failures never abort a run.** A throwing collector is recorded as `error` in `usage.collector_state`
  (cursor kept, so the next run retries from the same watermark) and the rest continue, even when Postgres is the
  failure and the error row cannot be written either (logged, the loop goes on, the summary line still prints); a collector with only a note and
  no records is `skipped`. `--full` hands the collector a null cursor; `--source` limits the run (and skips the
  quota / picks / portal passes, as does an injected collector set). A Postgres failure inside a pass is logged, not fatal
  to the other passes.
- **The upsert is idempotent on `(source, source_id)`** and fires only when a content column differs, so `ingested_at`
  moves on real change only even though hermes/feuer re-read their whole tables every run.
- **claude-code attribution** (`raw` from the collector, mapped in `laneFor` / `sessionKey`; detail in `docs/usage-schema.md` §Parent
  links): `raw.effort` (the line's `effort`) → `records.effort`; `raw.factoryRole` (the session's `FACTORY_ROLE` from `session_env`)
  decides the lane (`laneForRole`: it beats `USAGE_LANE`, which the factory runner sets to `wave` on every pane) and lands in
  `lane_detail.role`; a subagent line (`isSidechain` + `agentId`) is a session of its own `<parent>:<agentId>`, lane `subagent`,
  `lane_detail.subagent_type`, `parent_session_id` = the parent. `stats --by role|subagent_type|effort`.
- **claude-code lane precedence** (`stampLane`, `lane` on the record is `laneFor(subTool)`): the session's `USAGE_LANE`
  (from its session_env line), then agent-gateway's time-window fallback — only when no session_env line exists *and* the
  transcript `entrypoint` is `sdk-cli` or absent, since agent-gateway workers are always `claude -p` — then the entrypoint
  lane (`cli` → `interactive`, `sdk-cli` → `headless`, `claude-desktop` → `desktop`). Don't loosen the guard: it stops pruned
  long-lived herdr sessions from picking up random `agent-gateway:*` lanes. opencode rows without a lane are
  `interactive`, never null (the upsert would erase a lane). Lanes are derived at write time; `make restamp-claude-code` re-scans the transcripts so existing rows take a changed attribution (cost fingerprint checked before/after).
- **Session events** (`usage.session_events`, `docs/usage-schema.md` §Session events): compactions (`compact_boundary` lines) and `Skill`
  tool calls with their loaded size, keyed `(source, event_id)` (boundary uuid / `tool_use` id), never record attributes or
  `lane_detail`. A skill's call and its size line are two events with one id, merged by `upsertSessionEvents`, so a size
  arriving in a later poll completes the row; `args` is never stored. Counts and the cache hit ratio are the views
  `session_signals` / `lane_signals` (ratio from sums), nothing stored. Backfill them with `make backfill-events` (full scan, events only, cursor untouched, safe beside the LaunchAgent); `make restamp-claude-code` is only for attribution changes.
- **session_env** (`usage.session_env`: `base_url`, `lane`, `account`, `factory_role`, `factory_session` per hook session id) outlives the hook's 3-day log
  retention. `ingest` primes `models.ts` with the table, merges the logs on first lookup and writes new or changed
  lines before each batch, so billing / account / lane see them (details: `docs/collectors.md`). `seen_at` is the hook line's
  own `ts`; the newest line wins, an older one only fills a NULL lane or account. `billing-audit` compares
  the stored billing with the live log only.
- **`account` is a dimension, not a billing class.** `records.account` (`iu`|`me`|`me2`; account `iu` ≠ billing `api_key`)
  is set only for `max` rows — the source's own `raw.account`, else session_env's `account`, else `iu` (all historical
  lines predate it; legacy `a`/`b` map to `iu`/`me` via `parseAccount`). Derived in the writer via `resolveAccount`
  (models.ts, the only place that validates the account), never in a collector; a collector must put the session id in
  `raw.sessionId` for the lookup. A NULL Max row is a collector bug and stays visible.
- **IU keys: spend is split per key, each key has its own $500 rolling cap.** `records.api_key` (`personal` |
  `athena-team`, set only for `billing='api_key'` rows) is derived in the writer via `resolveIuKey` (`src/iu-keys.ts`): the
  row's own `raw.iuKey` label (validated against the registry, an unknown id never becomes a key) → the source's fixed
  key (`athena-teamchat` → `athena-team`) → `personal` (every historical row). Never in a collector except by
  `raw.iuKey`. A key's identity is a *label*: nothing in a model call says which key paid, so a producer that can use
  either key (agent-workflows host, OpenCode) must stamp `iuKey`/`iu_key` from non-secret host config; never log, hash or
  send key material. `stats --by iu_key`. The portal is asked once per registered key with that key typed into the form
  (`collectPortal` loops `IU_KEYS`; state `iu-portal` for personal, `iu-portal:<id>` otherwise; a signed-out session or
  unreachable MacBook ends the pass); only the personal report writes `latest.json` (non-personal scrapes pass
  `--no-latest`, so redeploy the iumac tool with `make iu-portal-setup` before a new key's first scrape).
  `usage.iu_portal_cost` / `iu_portal_total` carry `iu_key` in the key. A key whose portal figure exceeds what its
  collectors track is spend by a producer we do not see (the team key's 2026-10-22..25 build-phase use predates the
  Athena Postgres rows). `make health` goes stale per key (`iu-portal:athena-team`, once tried). Adding a key = one entry
  in `IU_KEYS` (the secret ref must be in the mini's secrets cache, `dotfiles-private/headless.iu.refs` for careerpartner
  refs).
- **`athena-teamchat` reads the Athena Teamchat Postgres** (`athena` schema, Unix socket
  `~/.local/state/athena/pgsock`, role `athena_app` via the owner's ident map; override `ATHENA_PG_SOCKET_DIR`,
  `ATHENA_PSQL`). `turns` (chat/analysis turns incl. the OpenCode sandbox: tokens + OpenCode's own cost),
  `llm_calls` (host-side calls, cost = tokens × configured prices), `title_calls`; source ids `turn:`/`llm:`/
  `title:<id>`, `subTool` `chat-turn:<kind>`/`llm:<caller>`/`title`, model NULL (not stored per call), cost
  authoritative. Re-reads three days behind the newest row because turns mutate until ended. No text is
  read, only counts. `block_results`/`quality_reports`/`artifact_audits` cost columns are cents and
  ignored. The relay is the only holder of the team key, so the whole source is the team key's.
  The build phase (2026-10-22..25, ~15.6 USD, evals through chat-api included) lives in the archived SQLite
  (`~/.local/share/teamchat/archive/chat.db.pre-athena-20261026.sqlite`, `ATHENA_ARCHIVE_DB`), read once as
  `sqlite-turn:`/`sqlite-title:` ids (cursor flag `archived`, `--full` re-reads). **Team-key spend still not
  tracked** (Athena orchestrator, 2026-10-28): the evals' direct extractor/judge calls (`chat/evals/run.py`,
  `golden_run.py`, same `LLM_RELAY_KEY`; cost only in `chat/evals/reports/<date>-*.json`), `epx web ask`
  (`WEB_ASK_API_KEY`; call log without cost in the broker audit `external=1`), the relay's docker logs (no
  tokens), and whatever agent-workflows' `w4-iu-key` run sends. The portal-vs-tracked gap is that remainder.
- **IU portal cost is the truth; `records.cost_usd` is an estimate.** The employee cap is a ROLLING 30-day window
  (today + 29 days, limit `LIMIT_USD` = 500 in `tools/iu-portal/latest.ts`), measured by IU's self-service portal.
  Reconciled so far: `sonar` (vendor cost ignored, token-priced), `gpt-5.6-terra` (IU billed no reasoning tokens before
  2026-10-16 08:55Z; the day's portal fit puts the cutoff nearer 12:00Z, ~$2.8), the IU-measured rates in migration 0005,
  the DeepSeek schedule (the catalog's) and the gateway mirror duplicates (below). Portal days are the portal's calendar (UTC assumed).
  `make budget [KEY=<id>] [MODEL=<name>]` is the reconciliation: rolling30, headroom, can-spend-today, 7-day drop-off and
  burn, portal vs tracked per day and model (flag when `|delta| > max($1, 20%)`), `MODEL` for the day-by-day explain
  (tokens, implied rate, tracked cost by source). Tracked = `usage.records_unique` with `billing='api_key'` and `api_key` =
  the key, by UTC day. Last reconciliation (2026-10-30, per key and day, every driver): `docs/reconciliation/2026-10-30-portal-actuals.md`. `reprice` never touches a row with `cost_reported_usd`. **Depends on iumac:** the scrape runs on the MacBook
  (`ssh iumac`, IU-managed Chrome, profile `~/.local/share/iu-portal/profile`, tooling in
  `~/.local/share/iu-portal/tool`, installed by `make iu-portal-setup`). `ingest` fetches at most every 4 h; a sleeping
  MacBook skips quietly, and `health` goes stale after 48 h. **Login runbook:** when the log says `session expired`, run
  `make iu-portal-login` (a dialog appears on the MacBook, sign in via Entra/Okta within 5 min), then `make iu-portal`.
  The API key is piped through stdin from `secrets-run`, never written. Each successful scrape also writes `latest.json`
  on iumac (the Tinycast contract, schema 1; `tools/iu-portal/latest.ts`), and each successful ingest writes the same
  document (same `buildLatest`) to the mini's `~/.local/share/iu-portal/latest.json` for agent-gateway's OCR budget gate
  (`rolling30_usd` ≥ $400 means no OCR reviews). Same contract, two machines: an expired session or failed scrape leaves
  the file untouched, so a consumer judges freshness by `fetched_at`. Mechanics: `docs/collectors.md`.
- **`usage.quota_samples` / `usage.account_picks`** (dotfiles `docs/claude-accounts.md`), filled on every `ingest` (skipped
  with `--source` or an injected collector set; run summary shows `quota=+N picks=+N`). `quota_samples` PK
  `(account, sampled_at, machine)`: one row per enabled account with at least one known window, from
  `claude-account usage --json` (cache-only, 5 s timeout, token env scrubbed; missing binary = silent skip,
  `USAGE_CLAUDE_ACCOUNT_BIN`). `sampled_at = now − min(window ages)`, so an unchanged cached sample dedupes via
  `ON CONFLICT DO NOTHING`; percentages are clamped to the column's 0-100. `account_picks` PK `(ts, lane, machine)`: one
  row per line of `~/.local/share/claude-accounts/picks.jsonl` (`USAGE_ACCOUNT_PICKS`), read by byte offset kept in
  `collector_state` under `account-picks` (advanced in the same transaction as the rows; resets when the file shrinks,
  malformed lines are skipped). `picked` is an opaque string — an account id or the `spill` sentinel; `snapshot` is the
  per-account `{s,w}` JSON. Legacy ids `a`/`b` are mapped to `iu`/`me` at ingest (in `picked` and snapshot keys); `spill`
  is kept. `bun run src/cli.ts quota [--days 7]` (`make quota`) prints the series and lane × picked × reason counts.
- **Weekly report** (`docs/usage-schema.md` §Weekly report). A pure function of the schema and an ISO week (Monday 00:00 UTC to
  the next); the default is the last full week, which on Monday 07:00 Europe/Berlin is the week that just ended. Findings
  are recomputed for both the week and the one before it, so effect tracking stores nothing. The change that answers a
  finding is a tracked entry in `docs/finding-changes.json` (`src/changes.ts`, strict parse; add one in the commit that
  lands the change, `docs/usage-schema.md` §Finding changes), printed under its finding. The report carries no secrets, hostnames or e-mails
  (skill names are untrusted free text and pass an allowlist). Window data only exists from 2026-10-24 (first quota
  reading), so 2026-W43 is partial and has no previous week. A missed run is not retried: Hermes prints a one-line
  "no report file" for the week, and `make report WEEK=<iso> OUT=1` regenerates it.
- **Staleness fails loud.** Every collector declares `staleAfterHours` (a number, or `null` for legacy/dormant — enforced
  by `health.test.ts`). `make health` and `ingest` exit 1 when an available source's newest row (`max(ts)` in
  `usage.records`) is older than that, and `make verify` runs `health`; ingest's exit feeds `jobs-grade` and so the
  dev-host heartbeat. A collector reporting `ok` on a moved store used to hide this.
- **agent-gateway and audio-gateway collectors are retired (2026-10-29, Wave 11).** The gateways stopped; agent-workflows
  posts its own rows (`source='agent-workflows'`), so no collector reads them. Removed: `agent-gateway-opencode`,
  `agent-gateway-iu`, `agent-gateway-sessions`, `audio-gateway`, `audio-gateway-vps` (and earlier `research-gateway`).
  **Historical rows stay** — never delete or rewrite them; `reprice` is the only thing that moves a cost, and the Wave 2
  exceptions are listed under "Costs that changed in Wave 2" below. What still reads that history: claude-code / opencode /
  litellm re-ingest uses the `agent-gateway:*` lanes and the `agent-gateway-sessions.jsonl` attribution log
  (`models.ts`), `reprice` skips their provider-reported costs (`cost_reported_usd`), and `classifyBilling` keeps its `agent-gateway-sessions`
  branch. Evidence: `docs/reconciliation/2026-10-29-agent-workflows.md`.
- **The backfill is insert-only by default.** `backfill-argo` writes billing / account / IU key as stored (`Preclassified` on
  the writer record) and prices everything but `cost_source = 'reported'` rows in SQL. For every source a row that exists is
  left alone (the live pipeline owns it); a session widens its span (`least`/`greatest`) and fills NULL attributes, so a
  session split across runs converges; records stay `DO NOTHING`. Overwriting (the initial load, a repair of one source) is
  explicit: `make backfill-argo OVERWRITE=all|<source,...>` rewrites those sources' rows whose content differs, and refuses to
  run while the ingest LaunchAgent is loaded (`launchctl print gui/$UID/com.jkrumm.usage-tracker`) unless `FORCE=1`, because
  ingest rewrites the same keys. After its write loop it runs `usage.flag_gateway_duplicates()` and prints the count. The
  proof document `docs/backfill/2026-10-30-argo-usage-record.md` is a record of the first load (it ran with the old default,
  `agent-workflows` only); its numbers stand. The state import (`import-sqlite-state`) never overwrites a cursor, and a
  `session_env` line only replaces an older one (the shared `upsertSessionEnv`).
- **Costs that changed in Wave 2** (the only exceptions to "history is never repriced"). (1) The backfill priced every row
  through `usage.prices` (the catalog plus `price_overrides`), not through the retired `src/pricing.ts`, so a re-derived
  `cost_usd` can differ from the SQLite/Argo one. (2) Migration `0006` moved the DeepSeek schedule to the catalog's and
  `reprice` repriced 46,617 DeepSeek rows. (3) 4,217 rows ($69.65 in the old store, e.g. `v3` ElevenLabs without token counts)
  now have NULL cost with `cost_source = 'none'`, because no price exists for them. Provider-reported costs
  (`cost_reported_usd`, `cost_source = 'reported'`) are verbatim. The old costs are not lost: the SQLite archive
  `~/.local/share/usage-tracker/usage.db` (`records.cost_usd`) and the untouched VPS table `argo.usage_record`
  (`cost_usd`, keyed `(source, source_id, machine)`) keep them; compare there before judging a delta.
- **The SQLite file `~/.local/share/usage-tracker/usage.db` is an archive**, the source of the one-off backfill. Nothing in
  the pipeline opens it; never delete or modify it. Collectors still read their sources' own stores (Hermes, Feuer,
  OpenCode, modelpick, the Athena archive) with `bun:sqlite` / `sqlite3`, read-only.
- **The cursor is saved after a collector's whole batch**, not per batch. A run killed at jobrun's 600 s deadline restarts
  that collector's scan from the old cursor on the next tick (idempotent upserts, only repeated work). Known limitation; a
  per-batch cursor is a later improvement.
- Claude Code resumes by byte offset per file (the cursor is a JSON map in `collector_state`) and only advances past
  complete lines; re-scanning is a `--full` backfill. The offset is **bytes** (the chunk is read as bytes and split on `0x0A`;
  before 2026-10-30 it was a character index, which undershot on multibyte text and re-read part of every such file on every
  poll). Cursors saved by the old code sit short of the true offset, never past it, so the first poll after the fix loses
  no line and writes the exact offset.
- The LaunchAgent logs to `~/Library/Logs`, never `/tmp` (macOS sweeps it). Keep the secrets design: no plaintext secret on
  disk — the Postgres password is resolved at spawn, never at install.
