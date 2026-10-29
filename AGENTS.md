# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table (`usage_record`), one pricing model, one CLI.
Collectors are dumb: they emit tokens and ids only. Model normalization, billing
classification and pricing live centrally, so a new source never re-implements
them. The SQLite DB is the staging layer; every `ingest` run also syncs
unsynced rows to the Argo API, which is where the dashboard lives.

## Layout

- `src/cli.ts` — CLI entrypoint: `ingest`, `sync`, `resync-account`, `reprice`, `relane`,
  `stats`, `quota`, `budget [--key]`, `iu-portal`, `sources`, `health`, `billing-audit`.
- `src/collectors/<name>.ts` — one file per source, emits `UsageRecord`s;
  registered in `src/collectors/index.ts`.
- `src/db.ts`, `src/schema.ts` — SQLite schema and the idempotent upsert keyed
  on `(source, source_id)`; `session_env` table persists the hook's per-session
  `base_url`/`lane` lines past log pruning.
- `src/collectors/iu-portal.ts`, `src/budget.ts`, `tools/iu-portal/` — IU's own cost report (the
  cap) scraped from the MacBook, and `budget`, which compares it with our estimate. See the
  "IU portal cost" gotcha.
- `src/collectors/claude-quota.ts`, `src/collectors/account-picks.ts` — not `usage_record`
  sources: the Claude Max account quota series and the dotfiles picker's decisions
  (see the `quota_sample` / `account_pick` gotcha).
- `src/argo.ts` (`argoConfig`, `postJson`) is the one HTTP path to Argo; `src/sync.ts` pushes
  `usage_record`, `src/sync-account.ts` the two account tables, `src/sync-portal.ts` the IU portal report (`POST /usage/iu-portal`).
- `src/iu-keys.ts` — the registry of IU API keys (`personal`, `athena-team`; ids, op:// refs, cap) and
  `resolveIuKey`, the one place that decides which key an IU row was billed to. See the "IU keys" gotcha.
- `src/collectors/athena-teamchat.ts` — Athena Teamchat's own spend from its Postgres (the team key's).
- `src/pricing.ts`, `src/models.ts` — rates, model normalization, billing
  classification, session_env lookup and the transcript-entrypoint lane map.
- `src/ingest.ts`, `src/sync.ts`, `src/reprice.ts`, `src/relane.ts`,
  `src/report.ts` — pipeline, backfills (`reprice`, `relane`) and reporting.
- `launchd/install-agent.sh` — renders and (re)loads the LaunchAgent.
- `docs/collectors.md` — per-collector mechanics and sharp edges.

## Validate

`make check` runs `make typecheck` (`bun run tsc --noEmit`) and then
`bun test` (Bun's runner; `*.test.ts` colocated in `src/`). There is no
separate linter. The targets are side-effect free — tests open scratch DBs
under `mkdtemp`, and the suite is the only validation the repo has.

## Deploy

`make deploy` is a thin alias for `make install-agent`
(`launchd/install-agent.sh`): it renders
`~/Library/LaunchAgents/com.jkrumm.usage-tracker.plist`, then
bootout/bootstrap/kickstart it. The agent runs
`bun run src/cli.ts ingest` every 900s under `jobrun` (dotfiles; `--timeout 600`,
state in `~/.local/state/jobs/`, graded by `jobs-grade`). Re-running the installer is idempotent,
so deploying a merged default branch is just `make deploy`. There is no CI and
no rollback path: revert the offending commit and `make deploy` again. The Argo
bearer is resolved at spawn via `secrets-run read` and is never written to disk.

## Verify & Monitor

- Health URL: none — this is a batch LaunchAgent, not a server.
- Kuma monitor: none dedicated; liveness is the `jobs` grade (`jobs-grade --table`),
  relayed by `make doctor` and the `MacMini Dev Host - Push` heartbeat (WARN-only).
- OTel `service.name`: none — the repo emits no OTel.
- `make verify` exits non-zero unless `launchctl print` sees
  `com.jkrumm.usage-tracker`, `~/Library/Logs/usage-tracker.log` is younger
  than 1800s, and `health` finds no stale source.
- Logs live in `~/Library/Logs/usage-tracker.{log,err}`; `make logs` tails the
  last 50 lines.

## Gotchas

- **agent-gateway and audio-gateway collectors are retired (2026-10-29, Wave 11).** The gateways stopped;
  agent-workflows posts its own rows to Argo (`source='agent-workflows'`), so no collector reads them.
  Removed: `agent-gateway-opencode`, `agent-gateway-iu`, `agent-gateway-sessions`, `audio-gateway`,
  `audio-gateway-vps` (and earlier `research-gateway`). **Historical rows stay** in SQLite and Argo — never
  delete, rewrite or reprice them. What still reads that history: `relane` and `claude-code`/`opencode`/`litellm`
  re-ingest (`ingest --full` upserts overwrite `sub_tool`) use the `agent-gateway:*` lanes and the
  `agent-gateway-sessions.jsonl` attribution log (`models.ts`), `reprice` skips their vendor-`reported` costs,
  and `classifyBilling` keeps its `agent-gateway-sessions` branch. Reconcile a past day:
  `sqlite3 ~/.local/share/usage-tracker/usage.db "select source,sub_tool,count(*),round(sum(cost_usd),2) from usage_record where ts like 'YYYY-MM-DD%' and source like 'agent-gateway%' group by 1,2"`.
  Evidence: `docs/reconciliation/2026-10-29-agent-workflows.md`.
- **IU keys: spend is split per key, each key has its own $500 rolling cap.** `usage_record.iu_key`
  (`personal` | `athena-team`, set only for `billing='iu'` rows, NULL otherwise) is derived in
  `db.upsertRecords` via `resolveIuKey` (`src/iu-keys.ts`): the row's own `raw.iuKey` label (validated
  against the registry, an unknown id never becomes a key) → the source's fixed key (`athena-teamchat` →
  `athena-team`) → `personal` (every historical row). Never in a collector except by `raw.iuKey`. A key's
  identity is a *label*: nothing in a model call says which key paid, so a producer that can use either key
  (agent-workflows host, OpenCode) must stamp `iuKey`/`iu_key` from non-secret host config; never log, hash or
  send key material. `stats --by iu_key`. The portal is asked once per registered key with that key typed into
  the form (`collectPortal` loops `IU_KEYS`; state `iu-portal` for personal, `iu-portal:<id>` otherwise; a
  signed-out session or unreachable MacBook ends the pass); only the personal report writes `latest.json`
  (non-personal scrapes pass `--no-latest`, so redeploy the iumac tool with `make iu-portal-setup` before
  a new key's first scrape). `iu_portal_cost` / `iu_portal_total` carry `iu_key` in the PK (migration
  `user_version` 3 rebuilds them and backfills `personal`). `make budget [KEY=<id>] [MODEL=<norm>]` reports
  each key against its own cap; a key whose portal figure exceeds what its collectors track is spend by a
  producer we do not see (the team key's 2026-10-22..25 build-phase use predates the Athena Postgres rows).
  `make health` goes stale per key (`iu-portal:athena-team`, once tried). Argo gets `iu_key` on `/usage/records`
  rows and `iuKey` on `/usage/iu-portal` rows; a missing field means `personal` on its side. **Non-personal rows
  are held back (stay queued) until `USAGE_SYNC_IU_KEYS=1`** — an Argo without per-key storage would file them
  as personal and its portal upsert would overwrite the personal cells; the installer sets the flag in the LaunchAgent env
  (Argo has stored per-key since 2026-10-28). Adding a key = one entry in
  `IU_KEYS` (the secret ref must be in the mini's secrets cache, `dotfiles-private/headless.iu.refs` for
  careerpartner refs).
- **`athena-teamchat` reads the Athena Teamchat Postgres** (`athena` schema, Unix socket
  `~/.local/state/athena/pgsock`, role `athena_app` via the owner's ident map; override `ATHENA_PG_SOCKET_DIR`,
  `ATHENA_PSQL`). `turns` (chat/analysis turns incl. the OpenCode sandbox: tokens + OpenCode's own cost),
  `llm_calls` (host-side calls, cost = tokens × configured prices), `title_calls`; source ids `turn:`/`llm:`/
  `title:<id>`, `sub_tool` `chat-turn:<kind>`/`llm:<caller>`/`title`, model NULL (not stored per call), cost
  authoritative. Re-reads three days behind the newest row because turns mutate until ended. No text is
  read, only counts. `block_results`/`quality_reports`/`artifact_audits` cost columns are cents and
  ignored. The relay is the only holder of the team key, so the whole source is the team key's.
  The build phase (2026-10-22..25, ~15.6 USD, evals through chat-api included) lives in the archived SQLite
  (`~/.local/share/teamchat/archive/chat.db.pre-athena-20261026.sqlite`, `ATHENA_ARCHIVE_DB`), read once as
  `sqlite-turn:`/`sqlite-title:` ids (cursor flag `archived`, `--full` re-reads). **Team-key spend still not
  tracked** (Athena orchestrator, 2026-10-28): the evals' direct extractor/judge calls (`chat/evals/run.py`,
  `golden_run.py`, same `LLM_RELAY_KEY`; cost only in `chat/evals/reports/<date>-*.json`), `epx web ask`
  (`WEB_ASK_API_KEY`; call log without cost in the broker audit `external=1`), the relay's docker logs (no
  tokens), and whatever agent-workflows' `w4-iu-key` run sends. `make budget KEY=athena-team` shows that
  remainder as the portal-vs-tracked gap.
- **IU portal cost is the truth; `usage_record.cost_usd` is an estimate.** The employee cap is a
  ROLLING 30-day window (today + 29 days, limit `LIMIT_USD` = 500 in `tools/iu-portal/latest.ts`),
  measured by IU's self-service portal. `make budget` reports rolling30, headroom, "can spend
  today", the next-7-day drop-off, the 7-day burn, and portal vs `billing='iu'` tracked cost per day
  and model (flag: |tracked − portal| > max($1, 20% of portal)). It compares, never replaces: a
  flagged row means our rate card, a missing collector or IU is wrong. `make budget MODEL=<norm>`
  (`budget --explain`) prints one model per day: calls, tokens, portal vs tracked USD per million
  tokens and tracked cost by source — quiet days where our rate equals the portal's prove the rate
  card, so a large gap on a busy day is calls no collector sees. Reconciled so far: `sonar` (vendor
  cost ignored, token-priced), `gpt-5.6-terra` (IU billed no reasoning tokens before 2026-10-16
  08:55Z, `reasoningFreeBefore`). Portal days are the
  portal's calendar (UTC assumed); tracked days are `substr(ts, 1, 10)`, so day-edge noise is
  expected. **Depends on iumac:** the scrape runs on the MacBook (`ssh iumac`, IU-managed
  Chrome, profile `~/.local/share/iu-portal/profile`, tooling in `~/.local/share/iu-portal/tool`,
  installed by `make iu-portal-setup`). `ingest` fetches at most every 4 h; a sleeping MacBook
  skips quietly, and `health` goes stale after 48 h. **Login runbook:** when the log says
  `session expired`, run `make iu-portal-login` (a dialog appears on the MacBook, sign in via
  Entra/Okta within 5 min), then `make iu-portal`. The API key is piped through stdin from
  `secrets-run`, never written. Each successful scrape also writes `latest.json` on iumac (the
  Tinycast contract, schema 1; `tools/iu-portal/latest.ts`), and each successful ingest
  writes the same document (same `buildLatest`) to the mini's
  `~/.local/share/iu-portal/latest.json` for agent-gateway's OCR budget gate
  (`rolling30_usd` ≥ $400 means no OCR reviews). Same contract, two machines: an expired
  session or failed scrape leaves the file untouched, so a consumer judges freshness by
  `fetched_at`. Mechanics: `docs/collectors.md`.
  **Argo sync:** `syncPortal` (inside `sync`, every 15 min) pushes `iu_portal_cost` / `iu_portal_total` to Argo's
  `POST /usage/iu-portal` when a fetch landed since the watermark (`collector_state` key `argo_portal_fetched_at`,
  advanced only after every batch returned ok). Each push resends the last 35 days (the window shifts and the
  portal settles days), first run sends everything; Argo upserts, so a replay is a no-op. A 404/405 (Argo not
  deployed yet) leaves the watermark alone. Argo computes the cap from this, not from `usage_record`.
- **Staleness fails loud.** Every collector declares `staleAfterHours` (a number, or
  `null` for legacy/dormant — enforced by `health.test.ts`). `bun run src/cli.ts health`
  (`make health`) and `ingest` exit 1 when an available source's newest row is older
  than that, and `make verify` runs `health`; ingest's exit feeds `jobs-grade` and so
  the dev-host heartbeat. A collector reporting `ok` on a moved store used to hide this.

- **`account` is a dimension, not a billing class.** `usage_record.account` (`iu`|`me`; account `iu` ≠ billing `iu`)
  is set only for `billing='max'` rows — the source's own `raw.account` (agent-gateway session lines carry one; collectors pass it through opaque), else session_env's `account`, else `iu` (all historical lines predate it; legacy `a`/`b` map to
  `iu`/`me` via `parseAccount`); `billing='iu'`/other rows are NULL. Derived in
  `db.upsertRecords` via `resolveAccount` (models.ts, the only place that validates the account), never in a
  collector; a collector must put the session id in `raw.sessionId` for the session_env lookup
  (agent-gateway-sessions does). The one-off migration
  (`PRAGMA user_version` 2, never data-gated: a later NULL Max row is a collector bug and stays NULL for
  `claude-accounts-verify`) backfills old `max` rows to `iu` and renames stored `a`/`b` to `iu`/`me` in
  `usage_record` and `session_env` (without touching `synced_at`). The post-push `synced_at` mark is
  conditional on the pushed `account` + `ingested_at`, so a row rewritten mid-push stays queued. After Argo
  stores `account` (W2 of dotfiles `docs/claude-accounts.md`), run
  `bun run src/cli.ts resync-account` once to push it for all `max` rows.
- **`quota_sample` / `account_pick`** (dotfiles `docs/claude-accounts.md`), filled on every
  `ingest` (skipped with `--source` or an injected collector set; run summary shows
  `quota=+N picks=+N`). `quota_sample` PK `(account, sampled_at ms, machine)`: one row per
  enabled account with at least one known window, from `claude-account usage --json`
  (cache-only, 5 s timeout, token env scrubbed; missing binary = silent skip,
  `USAGE_CLAUDE_ACCOUNT_BIN`). `sampled_at = now − min(window ages)`, so an unchanged cached
  sample dedupes via `INSERT OR IGNORE`. `account_pick` PK `(ts ms, lane, machine)`: one row
  per line of `~/.local/share/claude-accounts/picks.jsonl` (`USAGE_ACCOUNT_PICKS`), read by
  byte offset kept in `collector_state` under `account-picks`; offset resets when the file
  shrinks, malformed lines are skipped. `picked` is an opaque string — an account id or the
  `spill` sentinel; `snapshot` is the per-account `{s,w}` JSON. Legacy ids `a`/`b` are mapped to `iu`/`me` at ingest (in `picked` and snapshot keys); `spill` is kept. Tables are plain
  `CREATE IF NOT EXISTS` (no `user_version` bump needed). `bun run src/cli.ts quota [--days 7]`
  prints the series and lane × picked × reason counts.
- **Argo endpoints for them** (`sync.ts`, batches ≤1000, `synced=1` on 2xx):
  `POST /usage/quota-samples` `{samples:[{account, sampledAt, machine, fiveHourPct, sevenDayPct,
  fiveHourResetsAt, sevenDayResetsAt, authOk, exhaustedUntil, source}]}` and
  `POST /usage/account-picks` `{picks:[{ts, lane, picked, reason, stale, snapshot, machine}]}`
  (ISO timestamps, nullable resets). A 404/405 leaves rows unsynced, logs once per run at info,
  and never fails the run or the `usage_record` sync (`sync()` wraps the account push in a
  try/catch and always returns the usage result); other failures log an error and retry next run.
  A row whose conversion throws (e.g. an out-of-range epoch) is quarantined: `synced=-1`, row id
  logged at warn, never re-selected.
- Never compute cost in a collector. `db.upsertRecords` derives `model_norm`,
  `billing` and `cost_usd` centrally.
- The upsert is idempotent on `(source, source_id)`, and its UPDATE only fires
  when a column actually differs. That keeps `ingested_at` moving on real
  change only, which is what keeps the Argo sync a delta despite hermes/feuer
  re-reading their whole tables every run.
- claude-code `sub_tool` precedence: the session's `USAGE_LANE` (from
  `session_env`), then agent-gateway's time-window fallback — only when no
  `session_env` line exists *and* the transcript `entrypoint` is `sdk-cli` or
  absent, since agent-gateway workers are always `claude -p` — then the entrypoint
  lane (`cli` → `interactive`, `sdk-cli` → `headless`, `claude-desktop` →
  `desktop`). Don't loosen the guard: it stops pruned long-lived herdr sessions
  from picking up random `agent-gateway:*` lanes. opencode rows without a lane are
  `interactive`, never null (the upsert would erase a lane).
- `make relane` (`DRYRUN=1` first) backfills those lanes on stored rows and
  clears `synced_at` so the next sync re-pushes them.
- One broken collector must never abort the others. Failures are recorded as
  `error`/`skipped` in `collector_state` and the rest of the run continues.
- Claude Code resumes by byte offset per file and only advances past complete
  lines; re-scanning is a `--full` backfill.
- The LaunchAgent logs to `~/Library/Logs`, never `/tmp` (macOS sweeps it), and
  must never re-bake the Argo token into the plist. Keep the secrets design: no
  plaintext secret on disk — injected at spawn, never at install.
