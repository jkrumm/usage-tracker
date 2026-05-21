# usage-tracker

Local SQLite telemetry for token consumption and cost across every AI tool I
run. One normalized table, one pricing model, one CLI. Designed to grow: a new
source is one collector file. The SQLite DB is the staging layer — the eventual
plan is to sync it to Argo and build the dashboard there.

## What it ingests

| Source | Storage read | Grain | Dedup key | Status |
|-|-|-|-|-|
| `claude-code` | `~/.claude/projects/**/*.jsonl` (offset-incremental) | message | `requestId` | working |
| `hermes` | `~/.hermes/state.db` → `sessions` | session | `id` | working |
| `opencode` | `~/.local/share/opencode/opencode.db` → `session` | session | `id` | working |
| `feuer` | `~/IuRoot/prometheus-feuer-agent/state/hermes/state.db` → `sessions` | session | `id` | needs container read (see below) |

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

## Known gaps / follow-ups

- **Pricing is seed values.** `src/pricing.ts` carries published Anthropic list
  prices and the Feuer agent's configured Kimi/gpt rates. Verify against current
  numbers and IU's actual per-token EU rates before trusting `$` figures.
- **Feuer needs a container-side read.** Its `state.db` is bind-mounted into the
  running `feuer` Docker container, so the host file is mid-WAL and reads as
  malformed. The collector skips gracefully (status `skipped`, note `unreadable`)
  until a consistent read path exists — e.g. a small container export
  (`docker exec feuer python -c "..."` dumping `sessions` to JSON) or a
  Feuer-side telemetry export the tracker can read.
- **LiteLLM bridge is not yet a direct source.** The bridge logs nothing usable
  today. Bridge spend is currently captured indirectly via the consumers that
  route through it (Hermes, OpenCode, and Claude Code worker sessions tagged
  `Kimi-K2.6`). A direct, authoritative capture would add a LiteLLM callback
  writing per-request usage — a dotfiles config change plus a bridge restart.
- **Argo sync + dashboard.** This DB is the staging layer; syncing to Argo and
  rendering the dashboard there is the next milestone.
