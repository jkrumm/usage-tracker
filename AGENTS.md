# usage-tracker

Token and cost telemetry for every AI tool I run, ingested into the Postgres `usage` schema (database `shared` on
the mini, role `usage`). One normalized `usage.records` table, effective-dated prices in SQL, one CLI. Collectors are
dumb: they emit tokens and ids only. Model normalization, billing classification, sessions and pricing live
centrally in the writer (`src/pg/writer.ts`, `usage.compute_cost`; the claude-code collector stamps only the lane label, `laneFor` maps it), so a new source never re-implements them. A
LaunchAgent runs `ingest` every 900 s; the dashboard and APIs read the same schema. There is no staging store and no
push step.

## Layout

- `src/cli.ts` — CLI entrypoint: `ingest`, `stats`, `quota`, `iu-portal`, `budget`, `reprice`, `sources`, `health`,
  `billing-audit`, `window`, `credit`, `report weekly`, `repair`, `pg-migrate`, `prices-sync`, `prices-seed-history`.
- `src/ingest.ts` — the pipeline. One `connect()` (`src/pg/connect.ts`), each collector isolated, cursor and run
  bookkeeping in `usage.collector_state` (`src/pg/state.ts`: `loadCursor`, `saveState`, `records_total` = the
  source's row count), records through `upsertRecords`. Also drives the quota / picks / portal / credit passes.
- `src/collectors/<name>.ts` — one file per source, emits `UsageRecord`s; registered in `src/collectors/index.ts`.
- `src/pg/` — `connect.ts`, `migrate.ts`, `cli.ts` (the Postgres commands); `writer.ts` (`upsertRecords`: records,
  sessions, cost via SQL), `sessions.ts`, `session-env.ts`, `state.ts`; `testing.ts` + `fixture.ts` (scratch-database
  harness). Migrations: `migrations/pg/NNNN_name.sql`, `make pg-migrate`. Shape and rules: `docs/usage-schema.md`.
- `src/credit/` — the credit pass (`index.ts` registry + secrets + `runCreditPass`, `admin-api.ts` Admin API cost fetch, `cycle.ts` cycle
  math): the Admin API's daily cost into `usage.platform_cost` (migration 0015) and the current + previous `usage.credit_cycles` with
  metered/reconciled/unspent. Run by `ingest` after the collectors, at most hourly (`collector_state` key `credit`), or `credit [--days N]` (never throttled; exit 1 on a failed account); `docs/usage-schema.md` §Credit pass.
- `src/models.ts` — model normalization, `classifyBilling`, `resolveAccount`, the hook-log `session_env` lookups
  (`getSessionLane`, `useStoredSessionEnvs`, `pendingSessionEnvs`) and the transcript-entrypoint lane map.
- `src/pg/events.ts` — `upsertSessionEvents`: compactions, skill loads and tool calls (`usage.session_events`, migration 0013; views
  `session_signals` / `lane_signals` hold the cache hit ratio and the counts), emitted by the claude-code collector in
  `CollectResult.events`. See the "Session events" gotcha.
- `src/lane.ts` (`laneFor`), `src/repo.ts` — the pure lane and repo mappings the writer calls: `classifyRepo` (path, bare slug, session
  evidence, source owner, caller; renames and folds on every result), `normalizeRepo` (paths), `knownRepos` (directories under
  SourceRoot/IuRoot plus `RETIRED_REPOS`). See the "Repo attribution" gotcha.
- `src/pg/repair.ts` — `repairAttribution`: recomputes repo / workspace / model / issue_id of records and sessions from `project_raw`,
  `model_raw` and the transcripts, and marks the cutover duplicates; `make repair [DRYRUN=1] [FULL=1]`, run by `ingest` at most hourly
  (`collector_state` key `repair`). `src/pg/session-repo.ts` — the transcript evidence behind `usage.session_repo` (migration 0016).
- `src/report.ts` — `stats`, `sources`, `health` staleness, the attribution guard and the unpriced-Max-model guard, `unpricedByModel`, `billing-audit` over the `usage` schema.
- `src/window.ts` — `window`: the share of the Max 5 h / 7 d windows by session, lane, role, subagent type, issue, repo or
  account / model family over the `usage.window_attribution` / `session_window_share` views (migration 0011; rule and limits in
  `docs/usage-schema.md` §Window share; `session_window_share` is a materialized view since 0023, refreshed by `ingest` via
  `src/pg/window-share.ts`), `make window BY=lane`; the residual (window moved, no priced record) is printed. `src/window-fit.ts`:
  `window --fit` (`make window-fit`), the measured weight per model family; also the weekly report's weights table.
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
- `launchd/install-agent.sh` — renders and (re)loads the LaunchAgent; `launchd/reload-lib.sh` (sourced by all three installers) waits out the async `bootout` and retries `bootstrap`.
- `docs/collectors.md` — per-collector mechanics and sharp edges.

## Validate

`make check` runs a frozen-lockfile `bun install`, `oxfmt --check`, `oxlint --type-aware`,
`tsc --noEmit` and then `bun test` (Bun's runner; `*.test.ts` colocated in `src/`). `bun run format`
fixes formatting. The targets are side-effect free — every pipeline suite (ingest, collectors, report, health, writer,
prices) creates and drops a `usage_test_<random>` database as the admin role; the few SQLite tests left read scratch
files under `mkdtemp` (the sources' own stores). The harness
(`src/pg/testing.ts`) opens its admin connection over the unix socket of the mini's native cluster (`/tmp`, the OS user, no
password; the superuser has none), or over TCP when `USAGE_TEST_PG_URL` / `USAGE_TEST_PG_USER` + `USAGE_TEST_PG_PASSWORD` are set;
without either those suites skip with the reason in their name (a green run with skips proves nothing: check the count). No test touches the network.
The Postgres suites use the admin role (the OS user, superuser) on the shared mini server because they must `CREATE`/`DROP`
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
so deploying a merged default branch is just `make deploy`. `project.yaml` is the factory manifest (deploy mode `make`, target
`mini` verified by `make verify`, ship by push, migrations in `migrations/pg/`); `make version` prints the checkout's HEAD sha
(the LaunchAgent runs this checkout), which the factory compares to a shipped commit. There is no CI and
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
  last success), no unknown repo, at most 10% NULL-repo tokens in the last 7 days (`records_unique`) and no model with over 100 unpriced Max records. `make health`, `make sources`, `make stats BY=<dim>`, `make quota` read the same schema.
- Logs live in `~/Library/Logs/usage-tracker.{log,err}`; `make logs` tails the
  last 50 lines.

## Gotchas

Before changing the named area, Read its gotchas file. The rules there are verbatim from this file's former Gotchas section:

- Schema, prices, billing, repo attribution, lanes, session events, `session_env`, accounts: `docs/gotchas/schema-and-attribution.md`.
- IU keys, the IU portal, athena-teamchat, quota samples, account picks: `docs/gotchas/iu-spend.md`.
- Ingest, collector cursors and errors, backfill, the weekly report, staleness, the LaunchAgent: `docs/gotchas/ingest-and-reports.md`.
