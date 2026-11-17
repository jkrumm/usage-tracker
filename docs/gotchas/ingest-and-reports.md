# Gotchas: ingest, collectors, backfill, reports

- **Collector failures never abort a run.** A throwing collector is recorded as `error` in `usage.collector_state`
  (cursor kept, so the next run retries from the same watermark) and the rest continue, even when Postgres is the
  failure and the error row cannot be written either (logged, the loop goes on, the summary line still prints); a collector with only a note and
  no records is `skipped`. `--full` hands the collector a null cursor; `--source` limits the run (and skips the
  quota / picks / portal / credit passes, as does an injected collector set). A Postgres failure inside a pass is logged, not fatal
  to the other passes.
- **The upsert is idempotent on `(source, source_id)`** and fires only when a content column differs, so `ingested_at`
  moves on real change only even though hermes/feuer re-read their whole tables every run.

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
