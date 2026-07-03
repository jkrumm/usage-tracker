# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table, one pricing model, one CLI. Designed to grow: a new
source is one collector file. The SQLite DB is the staging layer — the eventual
plan is to sync it to Argo and build the dashboard there.

## What it ingests

| Source | Storage read | Grain | Dedup key | Status |
|-|-|-|-|-|
| `claude-code` | `~/.claude/projects/**/*.jsonl` (offset-incremental) | message | `requestId` | working (Max-only, see below) |
| `hermes` | `~/.hermes/state.db` → `sessions` | session | `id` | working |
| `opencode` | `~/.local/share/opencode/opencode.db` → `session` | session | `id` | working |
| `feuer` | `~/IuRoot/prometheus-feuer-agent/state/hermes/state.db` → `sessions` (full re-read via `sqlite3`) | session | `id` | working |
| `litellm` | `~/.local/share/usage-tracker/litellm.jsonl` (offset-incremental) | message | `request_id` | working |

Each source records tokens; almost none records reliable cost. So the tracker
computes one comparable cost for every row from its own pricing table
(`src/pricing.ts`) and tags each row with a `billing` class:

- `max` — Claude Code orchestrator on the Max subscription. Cost is the
  list-price *value* consumed, not a real bill.
- `iu` — routed through the IU LiteLLM bridge (Kimi-K2.6 etc.). Real per-token spend.

So `stats --by billing` answers both "how much Max value am I burning" and "what
am I actually paying IU".

Every row is also tagged with the `machine` that produced it (the macOS hardware
model + chip, e.g. `Mac mini (M2 Pro)`) so multiple laptops' DBs stay
distinguishable once merged — see "Machine attribution" below.

## Usage

```bash
make install            # bun install
make backfill           # first run: full scan of all sources
make ingest             # incremental (what the LaunchAgent runs)
make sync               # push unsynced rows to Argo API
make stats              # cost + tokens by source
make stats BY=model     # by model      (also: billing, day, machine, sub_tool)
make stats BY=day SINCE=7
make sources            # per-collector status, error rate, last run, last note
make install-agent      # 15-min incremental ingest via LaunchAgent
make logs               # tail agent logs
```

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
  session whose token counts grew simply updates the row.
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

### Claude Code Max-only exclusion

The `claude-code` collector keeps **only** Max-orchestrated Claude sessions
(`claude-*` without the `-eu` suffix). Every other model that can appear in a
claude-code session — DeepSeek, Kimi-K2.6, GPT, or `-eu` EU-routed Claude —
reached the model through the IU LiteLLM bridge and is already counted
per-request by the `litellm` source; admitting it here would double-count bridge
traffic. The guard is `classifyBilling(…) !== "max"` (`src/models.ts`), so any
non-Max model is dropped regardless of whether it has an explicit rate — which is
why `billing = 'unknown'` no longer occurs for this source.

### LiteLLM bridge

The litellm source reads a newline-delimited JSON log written by a LiteLLM
`CustomLogger` callback (`dotfiles/config/litellm/usage_logger.py`) — one line
per request. The collector consumes it by byte offset so it never re-reads
history. If the file is absent the collector reports not-present gracefully.

Each line carries `ts_start` / `ts_end` / `duration_ms`, so the bridge's
per-request latency is queryable directly.

### Sideclaw attribution

The bridge logger sees only tokens — it has no way to know which sideclaw tool
(`check`, `review`, `research`, `implement`, …) caused a given request. To
recover that, sideclaw's `runSession` appends one record per worker to
`~/.local/share/usage-tracker/sideclaw-sessions.jsonl` with
`{ tool, project, tsStart, tsEnd, outcome, durationMs, turns }`. The litellm
collector loads this on every run and tags rows whose `ts` falls inside a
window with `sub_tool` and `project`. When concurrent windows overlap, the
narrowest one wins (best-effort heuristic — small risk of misattribution under
heavy parallel fan-out). Review's three internal phases are tagged separately
as `review:router` / `review:angle` / `review:synthesis`.

Group by it with `make stats BY=sub_tool`.

### Bridge error rate

Kimi-K2.6 is single-backend (Azure Sweden) and intermittently 5xx/429s, so its
error rate is a property of the *bridge*, not of any one consumer — every source
routed through it (Hermes, sideclaw, OpenCode, …) sees the same rate. Rather than
attribute it per source, the logger's `async_log_failure_event` writes a
token-less `event: "error"` line whenever a request fails, and the collector
ingests those as `outcome = 'error'` rows. A failed attempt the fallback later
rescues still logs (the rescue is a separate success on `claude-sonnet-4-6-eu`),
which is the correct signal for Kimi availability.

`stats` counts only successful rows (`outcome = 'ok'`) so the error rows never
dilute token/cost totals; the error rate surfaces in `make sources` as `err%`.

### Machine attribution

The DB is local per machine; the eventual Argo sync merges several laptops' DBs
into one view. So every row is tagged at ingest time with the host that produced
it. The label is derived once per run: `USAGE_MACHINE` if set, else the macOS
hardware model + chip via `system_profiler` (e.g. `Mac mini (M2 Pro)`), falling
back to the hostname. Group by it with `make stats BY=machine`.

### Feuer access

Hermes and Feuer both run the hermes-agent runtime, so their `state.db` shares
the same `sessions` schema — including an FTS5 `messages_fts` virtual table.
`bun:sqlite` reads Hermes's DB fine but **fails to open Feuer's**
(`unable to open database file`): Feuer's FTS5 schema isn't constructible by
bun's bundled SQLite. The system `sqlite3` (and the container's `python3`) open
both cleanly.

So the host collector reads **out of process** via the system `sqlite3`
(`-json`, read-only) rather than `bun:sqlite` — one uniform path for both
daemons, robust regardless of the FTS5 schema. Setting `FEUER_CONTAINER=<name>`
switches Feuer to a `python3` read inside that container
(`file:/opt/data/state.db?mode=ro`) instead, for when the host bind-mount isn't
reachable. Either way the whole (small, rotating) `sessions` table is re-read
each run and reconciled by upsert — the source rotates old sessions out, so the
tracker stays the durable accumulator.

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
re-sent and updated on the server.

Only two env vars are required:

| Variable | Default | Description |
|-|-|-|
| `ARGO_URL` | `https://argo.jkrumm.com/api` | Base URL of the Argo API |
| `ARGO_TOKEN` | — (no default) | Bearer token for the Argo `/usage/records` endpoint |

If `ARGO_TOKEN` is absent the sync step logs one info line and does nothing —
not an error, so a machine that only collects locally is still fully functional.
This is also what happens when a fresh LaunchAgent is installed and `op` is not
available to retrieve the token at install time.
