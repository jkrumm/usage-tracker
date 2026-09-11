# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table, one pricing model, one CLI. Designed to grow: a new
source is one collector file. The SQLite DB is the staging layer; every
`ingest` run also syncs unsynced rows to Argo (`make sync`, or automatically at
the end of `ingest`), which is where the dashboard lives.

## What it ingests

| Source | Storage read | Grain | Dedup key | Status |
|-|-|-|-|-|
| `claude-code` | `~/.claude/projects/**/*.jsonl` + `**/<sessionId>/subagents/*.jsonl` (offset-incremental) — plus the same tree mirrored from the MacBook (`iumac`), see below | message | `requestId` | working (Max and IU-direct, every model id, billed by the session's base URL — see below) |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` (offset-incremental) — the OpenAI Codex CLI (`cx`/`cxa`) against the IU endpoint | message | `response_id` | working (local only — no MacBook mirror yet) |
| `hermes` | `~/.hermes/state.db` → `sessions` | session | `id` | working |
| `sideclaw-iu` | `~/.local/share/usage-tracker/sideclaw-iu.jsonl` (offset-incremental) — sideclaw's direct IU calls (`read_image`, `read_drawing`, `generate_image`, the `review` critic) | message | `request_id` | working |
| `opencode` | `~/.local/share/opencode/opencode.db` → `session` | session | `id` | historical rows only — OpenCode was removed 2026-09-04; the collector reports not-present |
| `feuer` | `~/IuRoot/prometheus-feuer-agent/state/hermes/state.db` → `sessions` (full re-read via `sqlite3`) | session | `id` | working |
| `litellm` | `~/.local/share/usage-tracker/litellm.jsonl` (offset-incremental) | message | `request_id` | historical rows only — the local LiteLLM proxy was removed 2026-09-04; the collector reports not-present |

Each source records tokens; almost none records reliable cost. So the tracker
computes one comparable cost for every row from its own pricing table
(`src/pricing.ts`) and tags each row with a `billing` class:

- `max` — Claude Code orchestrator on the Max subscription. Cost is the
  list-price *value* consumed, not a real bill.
- `iu` — real per-token IU spend against the IU unified endpoint: Claude Code
  on the `ca` launcher or sideclaw's `iu` lane (any served id, Claude or not),
  sideclaw's direct calls, and the agent daemons.

So `stats --by billing` answers "how much Max value am I burning" vs "what am
I actually paying IU" in one view.

Every row is also tagged with the `machine` that produced it (the macOS hardware
model + chip, e.g. `Mac mini (M2 Pro)`) so multiple laptops' DBs stay
distinguishable once merged — see "Machine attribution" below.

### Lane attribution (`sub_tool` for claude-code rows)

`claude-code` rows are otherwise anonymous — every Max-lane worker and every
`c`/`ca` session looks the same. Whoever spawns a session on purpose can set
`USAGE_LANE`; `hooks/notify.ts` logs it once per SessionStart next to
`base_url`, and the collector joins it onto every row for that session
(subagents included, since they share the parent's session id) as `sub_tool`.
`stats --by sub_tool` then breaks `claude-code` cost down by lane.

| Lane | Set by |
|-|-|
| `sideclaw:<tool>` (`sideclaw:review`, `sideclaw:dispatch`, `sideclaw:otel`, `sideclaw:check`) | sideclaw's `session-runner.ts`, one per routed tool |
| `wave` | `rd wave` |
| `bg` | `rd bg` |
| `warden` | warden-caused dispatch work |
| *(unset)* | manual `c`/`ca`/`cs`/`cf` sessions — `sub_tool` stays null |

## Usage

```bash
make install            # bun install
make backfill           # first run: full scan of all sources
make ingest             # incremental (what the LaunchAgent runs)
make sync               # push unsynced rows to Argo API
make reprice DRYRUN=1   # preview re-costing stored rows at the current rates
make reprice            # apply it (clears synced_at so `sync` re-pushes)
make stats              # cost + tokens by source
make stats BY=model     # by model      (also: billing, day, machine, sub_tool)
make stats BY=day SINCE=7
make sources            # per-collector status, error rate, last run, last note
make billing-audit      # per-session claude-code billing vs. the live session_env log
make billing-audit SESSION=<id> SINCE=7
make install-agent      # 15-min incremental ingest via LaunchAgent
make uninstall-agent    # stop + remove the LaunchAgent
make logs               # tail ~/Library/Logs/usage-tracker.{log,err}
```

Every ingest ends with one summary line on stdout (so it is the last line of
`usage-tracker.log`), e.g.
`run 2026-09-07T15:07:39.146Z status=ok claude-code=+12/40 hermes=+0/2413 … sync=12`
— a grep-able summary for humans. It is not the liveness signal: the devhost
heartbeat reads the log's mtime, which the per-source lines above already move.

DB path defaults to `~/.local/share/usage-tracker/usage.db` (override `USAGE_DB`).

The LaunchAgent is also installed automatically by the dotfiles `make setup`
(`_setup-usage-tracker` runs `bun install` + this repo's `install-agent.sh`).

## Design

```
collectors/*  →  normalized UsageRecord  →  db.upsertRecords()  →  usage_record
                 (tokens only)              (derives model_norm,
                                             billing, cost_usd)
```

- Collectors are dumb: they emit tokens + ids, nothing else. Model
  normalization, billing classification and pricing live centrally so a new
  source never re-implements them.
- Upsert is keyed on `(source, source_id)` and is idempotent — re-ingesting a
  session whose token counts grew simply updates the row. The update only fires
  when a column actually differs (row-value `IS NOT`), so `ingested_at` moves on
  real change only and the Argo sync stays a delta even though hermes/feuer
  re-read their whole table every run.
- Per-source watermarks live in `collector_state`. Claude Code resumes by byte
  offset per file (advancing only past complete lines); the small agent DBs are
  re-read whole each run and reconciled by upsert.
- One broken source never aborts the others — collectors are isolated and
  failures are recorded as `error`/`skipped` in `collector_state`.

## Adding a source

1. Write `src/collectors/<name>.ts` exporting a `Collector` (emit `UsageRecord`s).
2. Register it in `src/collectors/index.ts`.
3. If its model isn't priced yet, add a rate to `src/pricing.ts`.

## Source-specific notes

Per-collector mechanics (Claude Code billing classification, the iumac
MacBook mirror, sideclaw's direct-call log, the retired LiteLLM bridge,
machine attribution, the Feuer sqlite quirk) and the sharp edges each one
hit: [`docs/collectors.md`](docs/collectors.md).

## Known gaps / follow-ups

### Argo sync

Syncing with the Argo API happens automatically at the end of every `ingest` run
and can also be triggered manually with `bun run src/cli.ts sync` or
`make sync`. The sync reads every local `usage_record` row where
`synced_at IS NULL OR ingested_at > synced_at` and POSTs it in batches of 500
to the Argo endpoint. Argo identifies rows by the `(source, source_id)` pair
which is our unique key, so re-sending already-pushed rows simply updates them
on the server with the latest token counts and cost. This makes the sync safe to
run idempotently and means a row whose tokens grew since its last sync will be
re-sent and updated on the server. Because the upsert leaves `ingested_at`
untouched on an unchanged row (see Design), a quiet run pushes nothing — the
hermes/feuer full re-reads no longer re-send ~2.5k identical rows every 15 min.

Only two env vars are required:

| Variable | Default | Description |
|-|-|-|
| `ARGO_URL` | `https://argo.jkrumm.com/api` | Base URL of the Argo API |
| `ARGO_TOKEN` | — (no default) | Bearer token for the Argo `/usage/records` endpoint |

If `ARGO_TOKEN` is absent the sync step logs one info line and does nothing —
not an error, so a machine that only collects locally is still fully functional.
This is also what happens when the LaunchAgent's `secrets-run read` cannot
resolve the token at spawn (`launchd/install-agent.sh` renders the plist; it
logs to `~/Library/Logs/usage-tracker.{log,err}`, never `/tmp`).
