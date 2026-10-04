# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table (`usage_record`), one pricing model, one CLI.
Collectors are dumb: they emit tokens and ids only. Model normalization, billing
classification and pricing live centrally, so a new source never re-implements
them. The SQLite DB is the staging layer; every `ingest` run also syncs
unsynced rows to the Argo API, which is where the dashboard lives.

## Layout

- `src/cli.ts` — CLI entrypoint: `ingest`, `sync`, `reprice`, `stats`,
  `sources`, `billing-audit`.
- `src/collectors/<name>.ts` — one file per source, emits `UsageRecord`s;
  registered in `src/collectors/index.ts`.
- `src/db.ts`, `src/schema.ts` — SQLite schema and the idempotent upsert keyed
  on `(source, source_id)`.
- `src/pricing.ts`, `src/models.ts` — rates, model normalization and billing
  classification.
- `src/ingest.ts`, `src/sync.ts`, `src/reprice.ts`, `src/report.ts` — pipeline
  and reporting.
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
`bun run src/cli.ts ingest` every 900s. Re-running the installer is idempotent,
so deploying a merged default branch is just `make deploy`. There is no CI and
no rollback path: revert the offending commit and `make deploy` again. The Argo
bearer is resolved at spawn via `secrets-run read` and is never written to disk.

## Verify & Monitor

- Health URL: none — this is a batch LaunchAgent, not a server.
- Kuma monitor: none dedicated; usage-tracker's liveness ("log mtime < 30 min")
  is one component of the shared `MacMini Dev Host - Push` monitor.
- OTel `service.name`: none — the repo emits no OTel.
- `make verify` exits non-zero unless `launchctl print` sees
  `com.jkrumm.usage-tracker` and `~/Library/Logs/usage-tracker.log` is younger
  than 1800s.
- Logs live in `~/Library/Logs/usage-tracker.{log,err}`; `make logs` tails the
  last 50 lines.

## Gotchas

- Never compute cost in a collector. `db.upsertRecords` derives `model_norm`,
  `billing` and `cost_usd` centrally.
- The upsert is idempotent on `(source, source_id)`, and its UPDATE only fires
  when a column actually differs. That keeps `ingested_at` moving on real
  change only, which is what keeps the Argo sync a delta despite hermes/feuer
  re-reading their whole tables every run.
- One broken collector must never abort the others. Failures are recorded as
  `error`/`skipped` in `collector_state` and the rest of the run continues.
- Claude Code resumes by byte offset per file and only advances past complete
  lines; re-scanning is a `--full` backfill.
- The LaunchAgent logs to `~/Library/Logs`, never `/tmp` (macOS sweeps it), and
  must never re-bake the Argo token into the plist. Keep the secrets design: no
  plaintext secret on disk — injected at spawn, never at install.
