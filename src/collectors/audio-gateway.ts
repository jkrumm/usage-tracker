import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SSH_OPTS } from "../remote.ts";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// audio-gateway logs every upstream call it makes (podcast LLM steps, TTS, STT,
// cover images) to its own SQLite `usage_record` table and pushes nothing
// anywhere else — until this collector, that spend (Opus/Sonnet podcast
// segments, the writer bake-off) was invisible to the tracker and showed up
// only as unexplained IU portal cost.
//
// Two collectors, one mapping:
//   audio-gateway      the mini instance: `<data dir>/usage.db` plus every
//                      `<data dir>/<lab>/usage.db` (writer-bakeoff, writer-lab,
//                      wave3 — the lab scripts keep private ledgers by design
//                      and call the same IU key). Read-only bun:sqlite.
//   audio-gateway-vps  the VPS instance (STT/TTS + podcast history): the DB sits
//                      in the container's bind mount, the host has no sqlite3, so
//                      new rows are pulled as JSON through `ssh vps python3`.
//
// The ledger has no cost column. Priced here:
//   - `usage_json.cost` (the IU gateway's own number) -> authoritative;
//   - token rows of a model in the rate card -> priced centrally;
//   - audio rows (TTS/STT: seconds/chars only) -> no rate card entry exists, so
//     they stay unpriced and carry raw.unpriced = true (seconds/chars kept).
// `*-request` endpoints are wrapper rows that repeat the inner `speech` /
// `transcriptions` call (same audio seconds), so they are not ingested.
//
// Watermark: per-ledger {id, gen} = max `id` and the first row's ts. A ledger whose
// max id fell below the watermark, or whose first row changed, was recreated: it
// restarts from 0. source_id carries the row's own ts
// (`<ledger>:<id>@<ts>`) so ids reused by a recreated ledger never overwrite the
// earlier generation's rows, while a rescan of the same rows stays idempotent.

const DEFAULT_DATA_DIR = join(homedir(), "SourceRoot", "audio-gateway", "data");
const VPS_DB = "/var/lib/audio-gateway/usage.db";
const SSH_TIMEOUT_MS = 60_000;
const PROJECT = "audio-gateway";

export interface LedgerRow {
  id: number;
  ts: string;
  endpoint: string;
  model: string;
  status: number;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: number | null;
  input_chars: number | null;
  usage_json: string | null;
  error_text: string | null;
  caller: string | null;
}

interface LedgerPage {
  maxId: number;
  firstTs: string | null;
  rows: LedgerRow[];
}

interface Ledger {
  /** Prefix of every source_id from this ledger and the cursor key. */
  name: string;
  /** Host label stamped on its records; omitted = the local machine. */
  machine?: string;
  /**
   * Rows with id > afterId, the ledger's current max id (0 when empty) and its
   * first row's ts (the generation fingerprint: a recreated ledger starts later).
   */
  fetch(afterId: number): Promise<LedgerPage>;
}

const COLUMNS =
  "id, ts, endpoint, model, status, latency_ms, input_tokens, output_tokens, audio_seconds, input_chars, usage_json, error_text, caller";

function dataDir(): string {
  return process.env.AUDIO_GATEWAY_DATA_DIR ?? DEFAULT_DATA_DIR;
}

function localLedgers(): Ledger[] {
  const dir = dataDir();
  const paths: Array<{ name: string; path: string }> = [{ name: "mini", path: join(dir, "usage.db") }];
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) paths.push({ name: `mini/${e.name}`, path: join(dir, e.name, "usage.db") });
    }
  }
  return paths
    .filter((p) => existsSync(p.path))
    .map(({ name, path }) => ({
      name,
      async fetch(afterId) {
        const db = new Database(path, { readonly: true });
        try {
          const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM usage_record").get() as { m: number }).m;
          const rows = db
            .query(`SELECT ${COLUMNS} FROM usage_record WHERE id > ? ORDER BY id`)
            .all(afterId) as LedgerRow[];
          const first = db.query("SELECT ts FROM usage_record ORDER BY id LIMIT 1").get() as { ts: string } | null;
          return { maxId, firstTs: first?.ts ?? null, rows };
        } finally {
          db.close();
        }
      },
    }));
}

const VPS_SCRIPT = `
import sqlite3, json, sys
c = sqlite3.connect("file:${VPS_DB}?mode=ro", uri=True)
c.row_factory = sqlite3.Row
rows = c.execute("SELECT ${COLUMNS} FROM usage_record WHERE id > ? ORDER BY id", (int(sys.argv[1]),)).fetchall()
m = c.execute("SELECT COALESCE(MAX(id), 0) FROM usage_record").fetchone()[0]
f = c.execute("SELECT ts FROM usage_record ORDER BY id LIMIT 1").fetchone()
print(json.dumps({"maxId": m, "firstTs": f[0] if f else None, "rows": [dict(r) for r in rows]}))
`;

function vpsLedger(): Ledger {
  return {
    name: "vps",
    machine: "vps",
    async fetch(afterId) {
      const host = process.env.AUDIO_GATEWAY_VPS_HOST ?? "vps";
      const proc = Bun.spawn(["ssh", ...SSH_OPTS, host, "python3", "-", String(afterId)], {
        stdin: Buffer.from(VPS_SCRIPT),
        stdout: "pipe",
        stderr: "pipe",
        timeout: SSH_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`ssh ${host} exited ${code}: ${stderr.trim().slice(0, 160)}`);
      return JSON.parse(stdout) as LedgerPage;
    },
  };
}

interface UsageJson {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost?: number;
}

function parseUsage(json: string | null): UsageJson {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as UsageJson) : {};
  } catch {
    return {};
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Normalise the three usage shapes into this table's additive token contract. */
function tokens(row: LedgerRow, u: UsageJson) {
  if (typeof u.prompt_tokens === "number") {
    // OpenAI shape: prompt includes cached, completion includes reasoning.
    const cacheRead = num(u.prompt_tokens_details?.cached_tokens);
    const reasoning = num(u.completion_tokens_details?.reasoning_tokens);
    return {
      input: Math.max(num(u.prompt_tokens) - cacheRead, 0),
      output: Math.max(num(u.completion_tokens) - reasoning, 0),
      cacheRead,
      cacheWrite: 0,
      reasoning,
    };
  }
  if (typeof u.input_tokens === "number" || typeof u.cache_read_input_tokens === "number") {
    // Anthropic shape: cache read/creation are already separate from input.
    return {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      reasoning: 0,
    };
  }
  return {
    input: num(row.input_tokens),
    output: num(row.output_tokens),
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

/** `*-request` rows repeat the inner call; skipping them avoids double counting. */
function isWrapper(row: LedgerRow): boolean {
  return (row.endpoint ?? "").endsWith("-request");
}

export function toRecord(ledger: { name: string; machine?: string }, row: LedgerRow): UsageRecord | null {
  if (isWrapper(row)) return null;
  const failed = row.status >= 400 || !!row.error_text;
  const u = parseUsage(row.usage_json);
  const t = tokens(row, u);
  const hasTokens = t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning > 0;
  const audio = num(row.audio_seconds) > 0 || num(row.input_chars) > 0;
  // A failed call has no tokens by nature; keep it so the error rate is queryable.
  if (!hasTokens && !audio && typeof u.cost !== "number" && !failed) return null;

  const raw: Record<string, unknown> = { ledger: ledger.name, endpoint: row.endpoint, caller: row.caller };
  if (audio) {
    raw.audioSeconds = row.audio_seconds;
    raw.inputChars = row.input_chars;
    // No TTS/STT entry in the rate card: flagged so a future rate can reprice.
    if (typeof u.cost !== "number") raw.unpriced = true;
  }

  return {
    sourceId: `${ledger.name}:${row.id}@${row.ts}`,
    machine: ledger.machine,
    grain: "message",
    ts: row.ts,
    model: row.model || null,
    project: PROJECT,
    subTool: row.endpoint,
    inputTokens: t.input,
    outputTokens: t.output,
    cacheReadTokens: t.cacheRead,
    cacheWriteTokens: t.cacheWrite,
    reasoningTokens: t.reasoning,
    durationMs: row.latency_ms,
    outcome: failed ? "error" : "ok",
    authoritativeCostUsd: typeof u.cost === "number" && Number.isFinite(u.cost) ? u.cost : undefined,
    raw,
  };
}

interface Mark {
  id: number;
  gen: string | null;
}

function parseCursor(cursor: string | null): Record<string, Mark> {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor) as Record<string, Mark>;
  } catch {
    return {};
  }
}

async function collectLedgers(
  ledgers: Ledger[],
  ctx: CollectContext,
): Promise<CollectResult> {
  const cursor = ctx.full ? {} : parseCursor(ctx.cursor);
  const next: Record<string, Mark> = { ...cursor };
  const records: UsageRecord[] = [];
  const failures: string[] = [];

  for (const ledger of ledgers) {
    const mark = cursor[ledger.name] ?? { id: 0, gen: null };
    try {
      let page = await ledger.fetch(mark.id);
      if (mark.id > 0 && (page.maxId < mark.id || page.firstTs !== mark.gen)) {
        // Recreated ledger: its ids restarted, so the watermark is meaningless.
        page = await ledger.fetch(0);
      }
      for (const row of page.rows) {
        const rec = toRecord(ledger, row);
        if (rec) records.push(rec);
      }
      next[ledger.name] = { id: page.maxId, gen: page.firstTs };
    } catch (err) {
      const reason = `${ledger.name}: ${err instanceof Error ? err.message : String(err)}`;
      failures.push(reason);
      ctx.log.warn(`audio-gateway: skipped ${reason}`);
    }
  }

  return {
    records,
    cursor: JSON.stringify(next),
    note: failures.length > 0 ? `skipped ${failures.join("; ")}` : undefined,
  };
}

export const audioGatewayCollector: Collector = {
  source: "audio-gateway",
  staleAfterHours: 168,
  workspace: "private",
  available: () => existsSync(join(dataDir(), "usage.db")),
  collect: (ctx) => collectLedgers(localLedgers(), ctx),
};

export const audioGatewayVpsCollector: Collector = {
  source: "audio-gateway-vps",
  staleAfterHours: 168,
  workspace: "private",
  available: () => process.env.AUDIO_GATEWAY_VPS_DISABLE !== "1",
  collect: (ctx) => collectLedgers([vpsLedger()], ctx),
};
