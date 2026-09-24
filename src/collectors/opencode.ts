import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// OpenCode (sst/opencode) was re-added 2026-09-23 (v1.18.30). Re-verified
// against the live schema the same day: `session` still carries the same
// mutable per-session totals this collector originally read, but `message`
// (one row per turn, `data` a JSON blob) now carries per-assistant-message
// tokens/cost too — { role, path: { cwd }, cost, tokens: { input, output,
// reasoning, cache: { read, write } }, modelID, providerID, time: { created,
// completed }, finish }. Message grain is strictly finer (322 assistant
// messages across 19 sessions on 2026-09-24) and gives each row its own model
// and cwd, which session grain collapses to one value per session even when a
// session's cwd or model changes mid-run — so it's preferred. `part` is not
// read: token/cost data already lives on the assistant `message` row, nothing
// finer is needed at the part level.
//
// Both tables are re-read whole each run (no cursor-filtered query) and
// reconciled by upsert, same as before — the small DB and the short-lived
// LaunchAgent tick make a full re-read cheap, and message rows can still be
// updated in place while streaming.
//
// Falls back to the legacy session-grain query if `message` doesn't exist
// (an older OpenCode build) so this collector degrades gracefully rather than
// going dark.

function dbPath(): string {
  return process.env.USAGE_OPENCODE_DB?.trim() || join(homedir(), ".local", "share", "opencode", "opencode.db");
}

interface MessageRow {
  id: string;
  session_id: string;
  data: string;
  directory: string | null;
}

interface AssistantMessageData {
  role?: string;
  agent?: string | null;
  mode?: string | null;
  path?: { cwd?: string | null } | null;
  cost?: number | null;
  tokens?: {
    input?: number | null;
    output?: number | null;
    reasoning?: number | null;
    cache?: { read?: number | null; write?: number | null } | null;
  } | null;
  modelID?: string | null;
  providerID?: string | null;
  time?: { created?: number | null; completed?: number | null } | null;
  finish?: string | null;
}

interface SessionRow {
  id: string;
  directory: string | null;
  slug: string | null;
  title: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  time_created: number; // epoch ms
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

export const opencodeCollector: Collector = {
  source: "opencode",
  workspace: "private",

  available() {
    return existsSync(dbPath());
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    let db: Database | undefined;
    try {
      db = new Database(dbPath(), { readonly: true });
      try {
        return collectMessages(db);
      } catch (err) {
        // Only a missing `message` table falls back — anything else (locked DB,
        // corrupt file) should surface as a real failure below.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no such table")) throw err;
        return collectSessions(db);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { records: [], cursor: ctx.cursor, note: `unreadable: ${msg}` };
    } finally {
      db?.close();
    }
  },
};

function collectMessages(db: Database): CollectResult {
  const rows = db
    .query<MessageRow, []>(
      `SELECT m.id AS id, m.session_id AS session_id, m.data AS data, s.directory AS directory
       FROM message m
       JOIN session s ON s.id = m.session_id
       WHERE json_extract(m.data, '$.role') = 'assistant'`,
    )
    .all();

  const records: UsageRecord[] = [];
  let maxTs = 0;
  for (const row of rows) {
    const record = toMessageRecord(row);
    if (!record) continue;
    records.push(record);
    const ts = Date.parse(record.ts);
    if (Number.isFinite(ts)) maxTs = Math.max(maxTs, ts);
  }
  return { records, cursor: String(maxTs) };
}

function toMessageRecord(row: MessageRow): UsageRecord | null {
  let data: AssistantMessageData;
  try {
    data = JSON.parse(row.data) as AssistantMessageData;
  } catch {
    return null;
  }
  if (data.role !== "assistant") return null;

  const created = data.time?.created ?? null;
  const completed = data.time?.completed ?? null;
  const tokens = data.tokens ?? {};

  return {
    sourceId: row.id,
    grain: "message",
    ts: created != null ? new Date(created).toISOString() : new Date().toISOString(),
    // Plain modelID, not the {"id":…,"providerID":…} shape session rows carry —
    // normalizeModel's lowercase pass handles a bare id fine, no JSON needed.
    model: data.modelID ?? null,
    // Prefer the message's own cwd (per-request, so a worktree run inside a
    // multi-directory session is attributed correctly); fall back to the
    // session's directory when a message predates `path` being recorded.
    project: data.path?.cwd ?? row.directory ?? null,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cache?.read ?? 0,
    cacheWriteTokens: tokens.cache?.write ?? 0,
    reasoningTokens: tokens.reasoning ?? 0,
    durationMs: created != null && completed != null ? Math.max(0, completed - created) : null,
    raw: {
      sessionId: row.session_id,
      providerID: data.providerID ?? null,
      agent: data.agent ?? null,
      mode: data.mode ?? null,
      finish: data.finish ?? null,
      reportedCostUsd: data.cost ?? null,
    },
  };
}

function collectSessions(db: Database): CollectResult {
  const rows = db
    .query<SessionRow, []>(
      `SELECT id, directory, slug, title, agent, model, cost, time_created,
              tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write
       FROM session`,
    )
    .all();
  const records = rows.map((r) => toSessionRecord(r));
  const cursor = String(Math.max(0, ...rows.map((r) => r.time_created)));
  return { records, cursor };
}

function toSessionRecord(r: SessionRow): UsageRecord {
  return {
    sourceId: r.id,
    grain: "session",
    ts: new Date(r.time_created).toISOString(),
    model: r.model,
    project: r.directory,
    inputTokens: r.tokens_input ?? 0,
    outputTokens: r.tokens_output ?? 0,
    cacheReadTokens: r.tokens_cache_read ?? 0,
    cacheWriteTokens: r.tokens_cache_write ?? 0,
    reasoningTokens: r.tokens_reasoning ?? 0,
    raw: {
      slug: r.slug,
      title: r.title,
      agent: r.agent,
      reportedCostUsd: r.cost,
    },
  };
}
