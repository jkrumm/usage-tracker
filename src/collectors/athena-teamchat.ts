import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// Athena Teamchat's own spend, read from its Postgres (`athena` schema, a Unix socket,
// the `athena_app` role the owner's user maps to). Every inference call of the teamchat
// goes through the relay, which is the only holder of the Athena team key, so the whole
// source is billed to that key (iu-keys.ts SOURCE_KEYS) — the OpenCode sandbox turns
// included: their tokens and OpenCode's own cost land in `athena.turns`, which is why no
// OpenCode store is read for this key.
//
//   turns        chat + analysis turns (OpenCode usage per turn; cost = OpenCode's own estimate)
//   llm_calls    host-side structured calls (`caller` names them); cost = tokens x configured prices
//   title_calls  thread titles
//
// Not read: block_results / quality_reports / artifact_audits carry cost columns, but
// together they are cents and (audits) a derived follow-up number, so reading them would
// risk double counting for nothing. No model id is stored per call (the relay pins the
// allowed models), so rows have model NULL and carry their cost as authoritative.
//
// Rows are mutable until a turn ends, so each row carries `touched` (when it last changed:
// ended_at, else started_at / created_at) and each run re-reads from three days before the
// newest `touched` seen; the upsert only rewrites what changed.

const DEFAULT_SOCKET_DIR = join(homedir(), ".local", "state", "athena", "pgsock");
const DEFAULT_PSQL = "/opt/homebrew/opt/postgresql@18/bin/psql";
const OVERLAP_MS = 3 * 86_400_000;
const QUERY_TIMEOUT_MS = 60_000;

export interface AthenaRow {
  kind: "turn" | "llm" | "title";
  id: number;
  ts: string;
  /** Last change of the row: a turn's end, else its start; created_at for the other tables. */
  touched: string;
  tool: string;
  ok: boolean;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  ms: number | null;
}

export type AthenaQuery = (sinceIso: string) => Promise<AthenaRow[]>;

const socketDir = () => process.env.ATHENA_PG_SOCKET_DIR ?? DEFAULT_SOCKET_DIR;
const psqlBin = () => process.env.ATHENA_PSQL ?? DEFAULT_PSQL;

// One JSON document per run: psql -At prints a single text value.
const SQL = `
SELECT coalesce(json_agg(r ORDER BY r.ts), '[]'::json) FROM (
  SELECT 'turn' AS kind, id, started_at AS ts, coalesce(ended_at, started_at) AS touched, 'chat-turn:' || kind AS tool, state = 'ended' AS ok,
         tokens_in, tokens_out, cache_read_tokens AS cache_read, cache_write_tokens AS cache_write,
         cost::float8 AS cost, (extract(epoch FROM ended_at - started_at) * 1000)::bigint AS ms
    FROM athena.turns WHERE coalesce(ended_at, started_at) >= :'since'::timestamptz
  UNION ALL
  SELECT 'llm', id, created_at, created_at, 'llm:' || caller, ok, input_tokens, output_tokens, 0, 0, cost::float8, ms
    FROM athena.llm_calls WHERE created_at >= :'since'::timestamptz
  UNION ALL
  SELECT 'title', id, created_at, created_at, 'title', ok, input_tokens, output_tokens, 0, 0, cost::float8, ms
    FROM athena.title_calls WHERE created_at >= :'since'::timestamptz
) r;`;

export const psqlQuery: AthenaQuery = async (sinceIso) => {
  const proc = Bun.spawn(
    [psqlBin(), "-X", "-At", "-U", "athena_app", "-d", "athena", "-v", `since=${sinceIso}`, "-v", "ON_ERROR_STOP=1"],
    {
      stdin: Buffer.from(SQL),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGHOST: socketDir(), PGCONNECT_TIMEOUT: "10" },
      timeout: QUERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`psql exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`);
  return JSON.parse(out.trim() || "[]") as AthenaRow[];
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toRecord(row: AthenaRow): UsageRecord {
  return {
    sourceId: `${row.kind}:${row.id}`,
    grain: "message",
    ts: new Date(row.ts).toISOString(),
    model: null,
    project: "athena-teamchat",
    workspace: "work",
    subTool: row.tool,
    inputTokens: num(row.tokens_in),
    outputTokens: num(row.tokens_out),
    cacheReadTokens: num(row.cache_read),
    cacheWriteTokens: num(row.cache_write),
    reasoningTokens: 0,
    durationMs: typeof row.ms === "number" ? row.ms : null,
    outcome: row.ok ? "ok" : "error",
    authoritativeCostUsd: num(row.cost),
  };
}

interface Cursor {
  newest: string | null;
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { newest: null };
  try {
    return JSON.parse(raw) as Cursor;
  } catch {
    return { newest: null };
  }
}

export function athenaTeamchatCollector(query: AthenaQuery = psqlQuery): Collector {
  return {
    source: "athena-teamchat",
    staleAfterHours: 168, // a quiet week is not a broken source
    workspace: "work",

    available: () => existsSync(join(socketDir(), ".s.PGSQL.5432")) && existsSync(psqlBin()),

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const { newest } = ctx.full ? { newest: null } : parseCursor(ctx.cursor);
      const since = newest ? new Date(Date.parse(newest) - OVERLAP_MS).toISOString() : "1970-01-01T00:00:00Z";
      const rows = (await query(since)).filter((r) => {
        const ok = Number.isFinite(Date.parse(r.ts)) && Number.isFinite(Date.parse(r.touched));
        if (!ok) ctx.log.warn(`athena-teamchat: skipping ${r.kind}:${r.id} with an unparseable timestamp`);
        return ok;
      });
      const newestTouched = rows.reduce<number | null>((m, r) => Math.max(m ?? 0, Date.parse(r.touched)), null);
      const next = newestTouched === null ? newest : new Date(Math.max(newestTouched, newest ? Date.parse(newest) : 0)).toISOString();
      return { records: rows.map(toRecord), cursor: JSON.stringify({ newest: next } satisfies Cursor) };
    },
  };
}

export const athenaTeamchatDefault = athenaTeamchatCollector();
