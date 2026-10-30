import type { Collector, CollectContext, CollectResult, UsageRecord } from '../types.ts'

// email-gateway's model spend, read from the `llm.*` client spans it exports to the VPS ClickStack
// (src/telemetry/llm-call.ts in email-gateway: span `llm.<lane>`, lane classify|enrich|draft-reply|
// thread-summary|jev; attributes llm.model, llm.input_tokens (uncached input), llm.output_tokens,
// llm.cache_read_tokens, outcome ok|error). The gateway reports nothing to Argo any more, so the spans
// are the only trace of its calls. Transport is the otel skill's: keyless `ssh vps` + `docker exec -i
// clickstack clickhouse-client`, SQL on stdin. No change in email-gateway, no network grant.
//
// Tokens and ids only: billing (the gateway calls IU's endpoint with the shared key, so api_key/personal),
// lane and cost are derived in the writer. A model nobody priced (jev's pplx-decider-v1-27b) stays NULL /
// cost_source 'none'. Spans carry no prompt or output text, and none is requested.
//
// Volume is a handful of spans a month. The cursor is the newest span time seen; each run re-reads one day
// behind it (idempotent upserts on `<TraceId>:<SpanId>`).

const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
const REMOTE_CMD = 'docker exec -i clickstack clickhouse-client --format=JSONEachRow'
const OVERLAP_MS = 86_400_000
// Argo's backfilled history (`usage.records`, source `email-gateway`, ids are Argo's own) ends with the gateway's calls of
// 2026-10-24 09:45; the same calls are also spans. Reading spans from before this point would count them twice, so it is
// the floor of every read, `--full` included. Nothing was called between that day and the removal of Argo reporting.
export const HISTORY_FLOOR_MS = Date.parse('2026-10-24T10:00:00Z')
// A hang guard, not a budget: the otel skill's query tool uses 60 s for the same transport.
const QUERY_TIMEOUT_MS = 90_000

/** One `llm.*` span as selected by SQL. Numbers may arrive as JSON strings (ClickHouse quotes 64-bit ints). */
export interface SpanRow {
  ts_ms: number | string
  TraceId: string
  SpanId: string
  SpanName: string
  /** Nanoseconds. */
  Duration: number | string
  StatusCode: string
  model: string
  input_tokens: string
  output_tokens: string
  cache_read_tokens: string
  outcome: string
}

/** `sinceMs` is epoch milliseconds (a number, so it is safe to splice into the SQL). */
export type EmailGatewayQuery = (sinceMs: number) => Promise<SpanRow[]>

const sshBin = () => process.env.EMAIL_GATEWAY_SSH ?? 'ssh'
const sshHost = () => process.env.EMAIL_GATEWAY_SSH_HOST ?? 'vps'

export const spanSql = (sinceMs: number): string => `
SELECT toUnixTimestamp64Milli(Timestamp) AS ts_ms, TraceId, SpanId, SpanName, Duration, StatusCode,
       SpanAttributes['llm.model'] AS model,
       SpanAttributes['llm.input_tokens'] AS input_tokens,
       SpanAttributes['llm.output_tokens'] AS output_tokens,
       SpanAttributes['llm.cache_read_tokens'] AS cache_read_tokens,
       SpanAttributes['outcome'] AS outcome
FROM default.otel_traces
WHERE ServiceName = 'email-gateway' AND SpanName LIKE 'llm.%' AND Timestamp >= fromUnixTimestamp64Milli(${Math.max(0, Math.trunc(sinceMs))})
ORDER BY Timestamp`

/** JSONEachRow output: one JSON object per line. */
export function parseSpans(stdout: string): SpanRow[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SpanRow)
}

export const sshQuery: EmailGatewayQuery = async (sinceMs) => {
  const proc = Bun.spawn([sshBin(), ...SSH_ARGS, sshHost(), REMOTE_CMD], {
    stdin: Buffer.from(spanSql(sinceMs)),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new Error(`ssh ${sshHost()} exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`)
  return parseSpans(out)
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' && v === '' ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function toRecord(row: SpanRow): UsageRecord {
  const durationMs = num(row.Duration) / 1e6
  return {
    sourceId: `${row.TraceId}:${row.SpanId}`,
    grain: 'message',
    ts: new Date(Number(row.ts_ms)).toISOString(),
    model: row.model || null,
    project: 'email-gateway',
    subTool: `llm:${row.SpanName.replace(/^llm\./, '')}`,
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: durationMs > 0 ? Math.round(durationMs) : null,
    outcome: row.outcome === 'error' || row.StatusCode === 'Error' ? 'error' : 'ok',
  }
}

interface Cursor {
  newest: string | null
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { newest: null }
  try {
    return JSON.parse(raw) as Cursor
  } catch {
    return { newest: null }
  }
}

export function emailGatewayCollector(query: EmailGatewayQuery = sshQuery): Collector {
  return {
    source: 'email-gateway',
    // Exempt from the row-age check: the gateway makes a few model calls a month, so any row-age limit either fails a
    // healthy source or is too loose to mean anything. Silence is still loud: a failed read (ssh, ClickHouse) is a
    // collector `error` on every run, and `ingest` exits 1 on an error.
    staleAfterHours: null,
    workspace: 'private',

    // Always available: with the staleness check off, a missing ssh must be a recorded error, not a silent skip.
    available: () => true,

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const { newest } = ctx.full ? { newest: null } : parseCursor(ctx.cursor)
      const sinceMs = Math.max(HISTORY_FLOOR_MS, newest ? Date.parse(newest) - OVERLAP_MS : 0)
      const now = Date.now()
      const rows = (await query(sinceMs)).filter((r) => {
        // A span from the future (a skewed gateway clock) must not move the cursor past real ones still to come.
        const ok =
          Boolean(r.TraceId && r.SpanId) &&
          Number.isFinite(Number(r.ts_ms)) &&
          Number(r.ts_ms) >= HISTORY_FLOOR_MS &&
          Number(r.ts_ms) <= now + 3_600_000
        if (!ok)
          ctx.log.warn(
            `email-gateway: skipping a span without ids, or outside the readable time range, (${r.SpanName})`,
          )
        return ok
      })
      const records = [...new Map(rows.map(toRecord).map((r) => [r.sourceId, r])).values()]
      const newestMs = records.reduce(
        (m, r) => Math.max(m, Date.parse(r.ts)),
        newest ? Date.parse(newest) : -Infinity,
      )
      return {
        records,
        cursor: JSON.stringify({
          newest: Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null,
        } satisfies Cursor),
      }
    },
  }
}

export const emailGatewayDefault = emailGatewayCollector()
