# agent-gateway rename: usage data migration (2026-10-13)

The service was renamed from `sideclaw` to `agent-gateway` on 2026-10-09, but
the usage contract kept the old names on purpose. On 2026-10-13 it followed.
This page records the one-shot data migration so the old names in git history
and in old backups stay explainable.

| Old | New |
|-|-|
| source `sideclaw-iu` | `agent-gateway-iu` |
| source `sideclaw-sessions` | `agent-gateway-sessions` |
| lane / `sub_tool` / `session_env.lane` `sideclaw:<tool>` | `agent-gateway:<tool>` |
| sink `sideclaw-iu.jsonl`, `sideclaw-sessions.jsonl` | `agent-gateway-iu.jsonl`, `agent-gateway-sessions.jsonl` |
| env `SIDECLAW_SESSIONS_LOG` | `AGENT_GATEWAY_SESSIONS_USAGE_LOG` (the collector's own override) |

## Sequence

1. Unload the LaunchAgent (`launchctl bootout`), so nothing ingests mid-migration.
2. Back up the DB: `VACUUM INTO 'usage.db.bak-20261013-agent-gateway-rename'`.
3. Deploy agent-gateway (it now writes the new sink names and lanes).
4. Run the migration below; usage-tracker's new code was already on disk.
5. `make deploy` here reloads the LaunchAgent; the first pass reads the new files.

## Migration

- **Sinks.** `mv old new`. Where agent-gateway had already created the new file
  (a few lines written between its deploy and the migration), the old file is
  moved into place and the new lines appended after it. Collector cursors are
  byte offsets into the old content, which is a prefix of the merged file, so
  nothing is re-ingested or skipped.
- **DB**, one transaction, `synced_at` and `ingested_at` untouched (the rows
  are not re-pushed; Argo migrates its copy with drizzle `0021`):

  ```sql
  UPDATE usage_record SET source = 'agent-gateway-iu' WHERE source = 'sideclaw-iu';
  UPDATE usage_record SET source = 'agent-gateway-sessions' WHERE source = 'sideclaw-sessions';
  UPDATE usage_record SET sub_tool = 'agent-gateway:' || substr(sub_tool, 10) WHERE sub_tool LIKE 'sideclaw:%';
  UPDATE session_env SET lane = 'agent-gateway:' || substr(lane, 10) WHERE lane LIKE 'sideclaw:%';
  UPDATE collector_state SET source = 'agent-gateway-iu' WHERE source = 'sideclaw-iu';
  UPDATE collector_state SET source = 'agent-gateway-sessions' WHERE source = 'sideclaw-sessions';
  ```

- **Hook logs.** `~/.claude/logs/*.jsonl` (3-day rolling) re-feeds `session_env`
  on every pass and the log wins, so its `"lane":"sideclaw:` and
  `"src":"sideclaw"` values were rewritten in place too.
- **MacBook.** `iumac` only holds frozen June copies of the two sinks (nothing
  writes them there); they and the local rsync mirror were renamed so `--delete`
  mirroring stays consistent.

## Counts

| What | Rows |
|-|-|
| `usage_record` source `sideclaw-iu` | 1703 |
| `usage_record` source `sideclaw-sessions` | 6999 |
| `usage_record.sub_tool` `sideclaw:*` | 68221 |
| `session_env.lane` | 1375 |
| `collector_state` | 2 |

Left alone: `usage_record.project`, which holds working directories (the
`~/SourceRoot/sideclaw` checkout path of older sessions), not the contract.
