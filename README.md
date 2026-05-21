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
| `feuer` | Docker `feuer` container → `/opt/data/state.db` → `sessions` | session | `id` | postponed (see below) |
| `litellm` | `~/.local/share/usage-tracker/litellm.jsonl` (offset-incremental) | message | `request_id` | working |

Each source records tokens; almost none records reliable cost. So the tracker
computes one comparable cost for every row from its own pricing table
(`src/pricing.ts`) and tags each row with a `billing` class:

- `max` — Claude Code orchestrator on the Max subscription. Cost is the
  list-price *value* consumed, not a real bill.
- `iu` — routed through the IU LiteLLM bridge (Kimi-K2.6 etc.). Real per-token spend.

So `stats --by billing` answers both "how much Max value am I burning" and "what
am I actually paying IU".

## Usage

```bash
make install            # bun install
make backfill           # first run: full scan of all sources
make ingest             # incremental (what the LaunchAgent runs)
make stats              # cost + tokens by source
make stats BY=model     # by model      (also: billing, day)
make stats BY=day SINCE=7
make sources            # per-collector status, last run, last note
make install-agent      # 15-min incremental ingest via LaunchAgent
make logs               # tail agent logs
```

DB path defaults to `~/.local/share/usage-tracker/usage.db` (override `USAGE_DB`).

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

The `claude-code` collector intentionally skips worker sessions whose model
routes through the IU bridge (Kimi-K2.6, GPT-4o, etc.) or carries the `-eu`
suffix. Those requests are now counted directly by the `litellm` source; keeping
them in `claude-code` would double-count bridge traffic. Only Max-orchestrated
Claude sessions (`claude-*` without `-eu`) remain in the `claude-code` source.

### LiteLLM bridge

The litellm source reads a newline-delimited JSON log written by a LiteLLM
`CustomLogger` callback (`dotfiles/config/litellm/usage_logger.py`) — one line
per request. The collector consumes it by byte offset so it never re-reads
history. If the file is absent the collector reports not-present gracefully.

### Feuer access (postponed)

Feuer runs the hermes-agent runtime in a Docker container with its `state.db`
bind-mounted. Reading it from a *transient* SQLite connection fails with
`database disk image is malformed` — both from the host (mid-WAL bind mount) and
from inside the container. Root cause: the DB contains an FTS5 virtual table
(`messages_fts`); a fresh connection cannot construct the vtable
(`vtable constructor failed: messages_fts`), which poisons reads of the regular
`sessions` table too. The app's own long-lived connection is unaffected.

The docker-exec collector path is built and gated behind `FEUER_CONTAINER`
(unset by default → cheap skip). Re-enabling needs a read method that doesn't
use a transient stock-sqlite connection — e.g. read through the hermes-agent
runtime's own code (`lib/telemetry.py` already projects sessions), or have Feuer
export `sessions` to JSON on a schedule that the tracker ingests. Hermes (native,
`~/.hermes/state.db`) shares the identical schema and ingests fine — it is the
working hermes-agent POC.

## Known gaps / follow-ups

- **Feuer (postponed).** See "Feuer access" above — needs a non-transient read path.
- **Argo sync + dashboard.** This DB is the staging layer; syncing to Argo and
  rendering the dashboard there is the next milestone.
