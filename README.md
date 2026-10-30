# usage-tracker

Telemetry for token consumption and cost across every AI tool I run, in the
Postgres `usage` schema (database `shared`; contract: `docs/usage-schema.md`).
One normalized table, one pricing model, one CLI. Designed to grow: a new
source is one collector file. `ingest` writes straight to Postgres; the
dashboard reads the same schema.

## What it ingests

> **Retired 2026-10-29.** The `agent-gateway-opencode`, `agent-gateway-iu`, `agent-gateway-sessions`, `audio-gateway` and `audio-gateway-vps` collectors were removed with the gateways (agent-workflows posts its own usage). Their historical rows stay queryable.
>
> **Renamed 2026-10-13.** The `agent-gateway-iu` / `agent-gateway-sessions` sources, the `agent-gateway:<tool>` lanes and the `AGENT_GATEWAY_SESSIONS_USAGE_LOG` override carry the service's name on both sides. Stored rows and jsonl sinks were migrated in place — see `docs/history/agent-gateway-rename-migration.md`.

| Source | Storage read | Grain | Dedup key | Status |
|-|-|-|-|-|
| `claude-code` | `~/.claude/projects/**/*.jsonl` + `**/<sessionId>/subagents/*.jsonl` (offset-incremental) — plus the same tree mirrored from the MacBook (`iumac`), see below | message | `requestId` | working (Max and IU-direct, every model id, billed by the session's base URL — see below) |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` (offset-incremental) — the OpenAI Codex CLI (`cx`/`cxa`) against the IU endpoint | message | `response_id` | working (local only — no MacBook mirror yet) |
| `hermes` | `~/.hermes/state.db` → `sessions` | session | `id` | working |
| `opencode` | `~/.local/share/opencode/opencode.db` → `message` (per assistant turn), session-grain fallback if that table is absent | message | message `id` (session `id` on the fallback) | working — OpenCode was re-added 2026-09-23; removed 2026-09-04 → 2026-09-23, historical rows from before the removal stay queryable |
| `feuer` | `~/IuRoot/prometheus-feuer-agent/state/hermes/state.db` → `sessions` (full re-read via `sqlite3`) | session | `id` | working |
| `litellm` | `~/.local/share/usage-tracker/litellm.jsonl` (offset-incremental) | message | `request_id` | historical rows only — the local LiteLLM proxy was removed 2026-09-04; the collector reports not-present |

Each source records tokens; almost none records reliable cost. So the tracker
computes one comparable cost for every row from the effective-dated price
catalog (`usage.prices`, `usage.compute_cost`) and tags each row with a
`billing` class:

- `max` — Claude Code orchestrator on the Max subscription. Cost is the
  list-price *value* consumed, not a real bill.
- `api_key` — real per-token IU spend against the IU unified endpoint: Claude
  Code on the `ca` launcher (any served id, Claude or not), and the agent
  daemons. `api_key` on the row names the IU key.

So `stats --by billing` answers "how much Max value am I burning" vs "what am
I actually paying IU" in one view.

Every row is also tagged with the `machine` that produced it (the macOS hardware
model + chip, e.g. `Mac mini (M2 Pro)`) so several machines share one
database — see "Machine attribution" in `docs/collectors.md`.

### Lane attribution (`lane` for claude-code rows)

`claude-code` rows are otherwise anonymous — every Max-lane worker and every
`c`/`ca` session looks the same. Whoever spawns a session on purpose can set
`USAGE_LANE`; `hooks/notify.ts` logs it once per SessionStart next to
`base_url`, and the collector joins it onto every row for that session
(subagents included, since they share the parent's session id) as the record's lane
(`laneFor()` maps it onto the `usage.records.lane` vocabulary).
`stats --by lane` then breaks `claude-code` cost down by lane.

| Lane | Set by |
|-|-|
| `agent-gateway:<tool>` (`agent-gateway:review`, `agent-gateway:dispatch`, `agent-gateway:otel`, `agent-gateway:check`) | agent-gateway's `session-runner.ts`, one per routed tool |
| `wave` | `rd wave` |
| `bg` | legacy — `rd bg` (removed 2026-10-04); historical rows only |
| `warden` | warden-caused dispatch work |
| *(unset)* | manual `c`/`ca`/`cs`/`cf` sessions — the entrypoint lane (`interactive`) |

agent-gateway's own `writeSessionEnv()` (needed because its workers run with
`disableAllHooks`, so the real hook above never fires for them) has written a
`session_env` line carrying `lane` since 2026-09-24, so a going-forward
agent-gateway worker session resolves both billing (`base_url`) and its lane
straight from that join, same as any other spawner-set `USAGE_LANE`.
`getAgentGatewayLane()` (`src/models.ts`) is the fallback for a session with no
session_env line at all (pruned, or older than the fix) — it re-derives the
lane by matching the row's timestamp into a [`tsStart`,`tsEnd`] window from
agent-gateway's independent `agent-gateway-sessions.jsonl` attribution log (same
time-window technique the retired `litellm` collector used, since the two logs
share no session id to join on directly), preferring a window whose `project`
matches the row's cwd to disambiguate concurrent agent-gateway sessions.
`stampLane()` (`src/collectors/claude-code.ts`) only calls this fallback when
`getSessionLane()` returns `undefined` (no line at all) — never when a line
exists but its lane is null, which would otherwise mislabel a plain manual
session that happens to overlap an agent-gateway window in time.

## Usage

```bash
make install            # bun install
make backfill           # first run: full scan of all sources
make ingest             # incremental (what the LaunchAgent runs)
make stats              # cost + tokens by source
make stats BY=model     # by model      (also: billing, day, machine, lane, account, iu_key, repo)
make stats BY=day SINCE=7
make sources            # per-collector status, error rate, last run, last note
make health             # exit 1 when a source's newest row is older than its cadence
make quota              # Claude account 5h/7d quota series + picker decisions
make billing-audit      # per-session claude-code billing vs. the live hook log
make billing-audit SESSION=<id> SINCE=7
make install-agent      # 15-min incremental ingest via LaunchAgent
make uninstall-agent    # stop + remove the LaunchAgent
make logs               # tail ~/Library/Logs/usage-tracker.{log,err}
```

Every ingest ends with one summary line on stdout (so it is the last line of
`usage-tracker.log`), e.g.
`run 2026-09-07T15:07:39.146Z status=ok claude-code=+12/40 hermes=+0/2413 … unpriced=0`
— a grep-able summary for humans. It is not the liveness signal: the devhost
heartbeat reads the log's mtime, which the per-source lines above already move.

The connection is `USAGE_PG_URL`, else role `usage` on `shared` with the password read through `secrets-run` at
spawn. The old SQLite file `~/.local/share/usage-tracker/usage.db` is an archive; nothing opens it.

The LaunchAgent is also installed automatically by the dotfiles `make setup`
(`_setup-usage-tracker` runs `bun install` + this repo's `install-agent.sh`).

## Design

```
collectors/*  →  normalized UsageRecord  →  pg/writer.upsertRecords()  →  usage.records
                 (tokens only)              (derives model, billing, lane,   usage.sessions
                                             session; usage.compute_cost)
```

- Collectors are dumb: they emit tokens + ids, nothing else. Model
  normalization, billing classification, lanes and pricing live centrally so a new
  source never re-implements them.
- Upsert is keyed on `(source, source_id)` and is idempotent — re-ingesting a
  session whose token counts grew simply updates the row. The update only fires
  when a column actually differs (`IS DISTINCT FROM`), so `ingested_at` moves on
  real change only even though hermes/feuer re-read their whole table every run.
- Per-source watermarks live in `usage.collector_state`. Claude Code resumes by byte
  offset per file (advancing only past complete lines); the small agent DBs are
  re-read whole each run and reconciled by upsert.
- One broken source never aborts the others — collectors are isolated and
  failures are recorded as `error`/`skipped` in `usage.collector_state`.

## Adding a source

1. Write `src/collectors/<name>.ts` exporting a `Collector` (emit `UsageRecord`s).
2. Register it in `src/collectors/index.ts`.
3. If its model isn't priced yet, `make prices-sync` picks it up once an alias maps it to a catalog key
   (`src/prices/aliases.ts`); until then the row is NULL-cost (`make sources` lists them).

## Source-specific notes

Per-collector mechanics (Claude Code billing classification, the iumac
MacBook mirror, the retired LiteLLM bridge,
machine attribution, the Feuer sqlite quirk) and the sharp edges each one
hit: [`docs/collectors.md`](docs/collectors.md).
