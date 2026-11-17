# Gotchas: IU keys, IU portal, Athena, quota

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
  `title:<id>`, `subTool` `chat-turn:<kind>`/`llm:<caller>`/`title`, model from `turns.model` / `llm_calls.model` (NULL on older rows and the archived SQLite rows; `reasoning_tokens` is not read), cost
  authoritative (a reported cost is never repriced by the model). Re-reads three days behind the newest row because turns mutate until ended. No text is
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
