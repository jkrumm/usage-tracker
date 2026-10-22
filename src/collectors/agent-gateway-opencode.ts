import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord, Workspace } from "../types.ts";

// agent-gateway runs its OpenCode v2 server on its own store (since 2026-10-14),
// separate from the interactive `oc` store the legacy `opencode` collector
// reads. Same engine, different schema: `session_v2` (one row per session,
// `metadata` JSON carrying `{ agw: { jobId, tool } }`) and `session_message`
// (`type = 'assistant'` rows, `data` JSON with `cost`, `tokens` { input, output,
// reasoning, cache: { read, write } }, `model` { id, providerID }, `time`).
//
// Message grain, one record per assistant message, with the gateway-reported
// `cost` stored verbatim (authoritative: the IU endpoint bills it, and the
// session's cost column is exactly the sum of its messages' costs). Nothing
// here overlaps another source: `agent-gateway-iu` is agw's own direct IU
// fetches (multimodal tools, review critic) and `agent-gateway-sessions` is the
// per-job operational log with zero tokens — neither sees OpenCode traffic.
//
// Incremental on `session_message.time_updated` (an assistant message is
// rewritten while it streams), with a `>=` re-read of the boundary instant.

function dbPath(): string {
  return (
    process.env.USAGE_AGW_OPENCODE_DB?.trim() ||
    join(homedir(), ".local", "share", "agent-gateway", "opencode", "opencode.db")
  );
}

interface Row {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
  directory: string | null;
  metadata: string | null;
}

interface AssistantData {
  agent?: string | null;
  model?: { id?: string | null; providerID?: string | null } | null;
  cost?: number | null;
  finish?: string | null;
  time?: { created?: number | null; completed?: number | null } | null;
  tokens?: {
    input?: number | null;
    output?: number | null;
    reasoning?: number | null;
    cache?: { read?: number | null; write?: number | null } | null;
  } | null;
}

export const agentGatewayOpencodeCollector: Collector = {
  source: "agent-gateway-opencode",
  staleAfterHours: 48,

  available() {
    return existsSync(dbPath());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    // A store that can't be read throws: ingest records `error` and exits 1 on the
    // run that breaks, instead of waiting out the staleness window.
    let db: Database | undefined;
    try {
      db = new Database(dbPath(), { readonly: true });
      const since = ctx.full ? 0 : Number(ctx.cursor) || 0;
      const rows = db
        .query<Row, [number]>(
          `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data,
                  s.directory AS directory, s.metadata AS metadata
           FROM session_message m
           JOIN session_v2 s ON s.id = m.session_id
           WHERE m.type = 'assistant' AND m.time_updated >= ?
           ORDER BY m.time_updated`,
        )
        .all(since);

      const records: UsageRecord[] = [];
      let maxUpdated = since;
      for (const row of rows) {
        maxUpdated = Math.max(maxUpdated, row.time_updated);
        const record = toRecord(row);
        if (record) records.push(record);
      }
      return { records, cursor: String(maxUpdated) };
    } finally {
      db?.close();
    }
  },
};

function toRecord(row: Row): UsageRecord | null {
  let data: AssistantData;
  try {
    data = JSON.parse(row.data) as AssistantData;
  } catch {
    return null;
  }
  const agw = parseAgwMetadata(row.metadata);
  const tokens = data.tokens ?? {};
  const created = data.time?.created ?? row.time_created;
  // A poison timestamp must not throw out of the batch and wedge the cursor.
  if (typeof created !== "number" || !Number.isFinite(created) || Number.isNaN(new Date(created).getTime())) return null;
  const completed = data.time?.completed ?? null;

  return {
    sourceId: row.id,
    grain: "message",
    ts: new Date(created).toISOString(),
    model: data.model?.id ?? null,
    project: row.directory,
    workspace: workspaceOf(row.directory),
    // `bench:<model>:<case>:<n>:<hash>` is high-cardinality noise as a lane.
    subTool: agw.tool?.startsWith("bench:") ? "bench" : (agw.tool ?? null),
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cache?.read ?? 0,
    cacheWriteTokens: tokens.cache?.write ?? 0,
    reasoningTokens: tokens.reasoning ?? 0,
    durationMs: completed != null ? Math.max(0, completed - created) : null,
    authoritativeCostUsd: typeof data.cost === "number" ? data.cost : null,
    raw: {
      sessionId: row.session_id,
      jobId: agw.jobId,
      providerID: data.model?.providerID ?? null,
      agent: data.agent ?? null,
      finish: data.finish ?? null,
    },
  };
}

function parseAgwMetadata(metadata: string | null): { jobId: string | null; tool: string | null } {
  if (!metadata) return { jobId: null, tool: null };
  try {
    const agw = (JSON.parse(metadata) as { agw?: { jobId?: unknown; tool?: unknown } }).agw;
    return {
      jobId: typeof agw?.jobId === "string" ? agw.jobId : null,
      tool: typeof agw?.tool === "string" ? agw.tool : null,
    };
  } catch {
    return { jobId: null, tool: null };
  }
}

function workspaceOf(directory: string | null): Workspace | null {
  if (!directory) return null;
  return directory.includes("/IuRoot/") ? "work" : "private";
}
