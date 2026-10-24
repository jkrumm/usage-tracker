# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table (`usage_record`), one pricing model, one CLI.
Collectors are dumb: they emit tokens and ids only. Model normalization, billing
classification and pricing live centrally, so a new source never re-implements
them. The SQLite DB is the staging layer; every `ingest` run also syncs
unsynced rows to the Argo API, which is where the dashboard lives.

## Layout

- `src/cli.ts` — CLI entrypoint: `ingest`, `sync`, `resync-account`, `reprice`, `relane`,
  `stats`, `quota`, `sources`, `health`, `billing-audit`.
- `src/collectors/<name>.ts` — one file per source, emits `UsageRecord`s;
  registered in `src/collectors/index.ts`.
- `src/db.ts`, `src/schema.ts` — SQLite schema and the idempotent upsert keyed
  on `(source, source_id)`; `session_env` table persists the hook's per-session
  `base_url`/`lane` lines past log pruning.
- `src/collectors/claude-quota.ts`, `src/collectors/account-picks.ts` — not `usage_record`
  sources: the Claude Max account quota series and the dotfiles picker's decisions
  (see the `quota_sample` / `account_pick` gotcha).
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

- **agent-gateway spend is three disjoint sources — never fold them.**
  `agent-gateway-opencode` = every OpenCode worker session (review angles/synthesis,
  dispatch, check, bench, overview…) read from agw's own OpenCode store: tokens and exact
  `cost`, `raw.jobId`. `agent-gateway-iu` = agw's own direct IU `fetch`es (review
  adversary/router/OCR, read_image, prose, triage, decide…), logged to
  `agent-gateway-iu.jsonl`. `agent-gateway-sessions` = the per-job operational log,
  zero tokens and zero cost by design (outcome/duration only). Reconcile a day:
  `sqlite3 ~/.local/share/usage-tracker/usage.db "select source,sub_tool,count(*),round(sum(cost_usd),2) from usage_record where ts like 'YYYY-MM-DD%' and source like 'agent-gateway%' group by 1,2"`
  — no `sub_tool` should carry cost under `-sessions`, and `source_id`s never collide
  across sources. The legacy `opencode` collector reads only the interactive `oc` store.
- **Staleness fails loud.** Every collector declares `staleAfterHours` (a number, or
  `null` for legacy/dormant — enforced by `health.test.ts`). `bun run src/cli.ts health`
  (`make health`) and `ingest` exit 1 when an available source's newest row is older
  than that, and `make verify` runs `health`; ingest's exit feeds `jobs-grade` and so
  the dev-host heartbeat. A collector reporting `ok` on a moved store used to hide this.

- **`account` is a dimension, not a billing class.** `usage_record.account` (`iu`|`me`; account `iu` ≠ billing `iu`)
  is set only for `billing='max'` rows — session_env's `account`, else `iu` (all
  historical lines predate it; legacy `a`/`b` map to `iu`/`me` via `parseAccount`);
  `billing='iu'`/other rows are NULL. Derived in
  `db.upsertRecords` via `classifyAccount`, never in a collector; the migration
  backfills old `max` rows to `iu` and renames stored `a`/`b` to `iu`/`me` in
  `usage_record` and `session_env` (without touching `synced_at`). After Argo
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
  and never fails the run or the `usage_record` sync; other failures log an error and retry next run.
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
