import type { SQL } from "bun";
import { resolveIuKey } from "../iu-keys.ts";
import { laneFor } from "../lane.ts";
import { log } from "../log.ts";
import { currentMachine } from "../machine.ts";
import { classifyBilling, normalizeModel, resolveAccount } from "../models.ts";
import { baseModel } from "../prices/aliases.ts";
import { normalizeRepo } from "../repo.ts";
import type { Billing, UsageRecord, Workspace } from "../types.ts";
import { readSessionEnv, sessionEnvLookups } from "./session-env.ts";
import { aggregateSessions, parentSessionKey, sessionKey, type SessionInput } from "./sessions.ts";

// The Postgres write path for usage.records and usage.sessions (docs/usage-schema.md). Same job as
// db.upsertRecords for SQLite, with three differences: the key is (source, source_id) and machine an attribute,
// cost is computed IN SQL by usage.compute_cost (the one pricing implementation), and every record with a session id
// is linked to a usage.sessions row. Nothing calls this yet: the ingest pipeline is still SQLite until the next step.

/** Rows per round trip pair (sessions + records). Large enough for the ~850k-row backfill, small enough to stay fast to plan. */
const CHUNK = 500;

/** Models whose vendor-reported cost is not what IU charges (sonar: list price incl. search fees): tokens price them. */
export const IGNORE_REPORTED_COST: ReadonlySet<string> = new Set(["sonar"]);

/**
 * IU billed no reasoning tokens for these models before the instant (gpt-5.6-terra: the portal matched input + output +
 * cache only until 2026-10-16 ~08:55Z). Earlier rows keep their count in `raw.reasoningTokensUnbilled` and write 0 in
 * `reasoning_tokens`, so usage.compute_cost bills the reasoning share only from then on.
 */
export const REASONING_FREE_BEFORE: Readonly<Record<string, string>> = {
  "gpt-5.6-terra": "2026-10-16T08:55:00Z",
};

export interface WriteOptions {
  defaultWorkspace?: Workspace | null;
  /** Stamped as `ingested_at` of inserted and changed rows; default the database's now(). */
  now?: Date;
}

export interface WriteSummary {
  processed: number;
  newRows: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const tokens = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** The billing class of usage.records: the SQLite `max`/`iu`/`anthropic-api` vocabulary mapped to who actually pays. */
export function mapBilling(billing: Billing): "max" | "api_key" | "unknown" {
  if (billing === "max") return "max";
  if (billing === "iu" || billing === "anthropic-api") return "api_key";
  return "unknown";
}

interface Row {
  source_id: string;
  grain: string;
  ts: string;
  session_key?: string;
  model_raw?: string;
  model?: string;
  repo?: string;
  project_raw?: string;
  workspace?: string;
  billing: string;
  account?: string;
  api_key?: string;
  machine?: string;
  outcome: string;
  lane: string;
  lane_detail?: object;
  effort?: string;
  issue_id?: string;
  run_id?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  reasoning_tokens: number;
  duration_ms?: number;
  cost_reported_usd?: number;
  raw?: object;
}

/** One record to its usage.records row (undefined fields are NULL: they are dropped from the JSON payload). */
function toRow(
  source: string,
  r: UsageRecord,
  opts: WriteOptions,
  machine: string,
  env: ReturnType<typeof sessionEnvLookups>,
): { row: Row; session: SessionInput | null } {
  const norm = normalizeModel(r.model);
  const model = norm ? baseModel(norm) : null;
  const rawSessionId = str(r.raw?.sessionId);
  const classified = classifyBilling(source, r.model, rawSessionId, str(r.raw?.backend), env.baseUrl);
  const billing = mapBilling(classified);
  const account = resolveAccount({ billing: classified, raw: r.raw }, env.account);
  const apiKey = classified === "iu" ? resolveIuKey({ source, billing: classified, raw: r.raw }) : null;
  const { lane, detail } = laneFor(r.subTool ?? null, source, r.raw);

  const cacheWrite = tokens(r.cacheWriteTokens);
  const cacheWrite1h = Math.min(tokens(r.cacheWrite1hTokens), cacheWrite);

  let reasoning = tokens(r.reasoningTokens);
  let raw: object | undefined = r.raw;
  const freeBefore = model ? REASONING_FREE_BEFORE[model] : undefined;
  if (freeBefore && reasoning > 0 && Date.parse(r.ts) < Date.parse(freeBefore)) {
    raw = { ...r.raw, reasoningTokensUnbilled: reasoning };
    reasoning = 0;
  }

  const reported =
    typeof r.authoritativeCostUsd === "number" && Number.isFinite(r.authoritativeCostUsd) && !IGNORE_REPORTED_COST.has(norm ?? "")
      ? r.authoritativeCostUsd
      : undefined;

  const key = sessionKey(source, r);
  const effort = str(r.raw?.effort);
  const issueId = str(r.raw?.issueId);
  const runId = str(r.raw?.runId);
  const repo = normalizeRepo(r.project);
  const ts = new Date(r.ts).toISOString();

  const row: Row = {
    source_id: r.sourceId,
    grain: r.grain,
    ts,
    session_key: key ?? undefined,
    model_raw: r.model ?? undefined,
    model: model ?? undefined,
    repo: repo ?? undefined,
    project_raw: r.project ?? undefined,
    workspace: r.workspace ?? opts.defaultWorkspace ?? undefined,
    billing,
    account: account ?? undefined,
    api_key: apiKey ?? undefined,
    machine,
    outcome: r.outcome ?? "ok",
    lane,
    lane_detail: detail ?? undefined,
    effort: effort ?? undefined,
    issue_id: issueId ?? undefined,
    run_id: runId ?? undefined,
    input_tokens: tokens(r.inputTokens),
    output_tokens: tokens(r.outputTokens),
    cache_read_tokens: tokens(r.cacheReadTokens),
    cache_write_5m_tokens: cacheWrite - cacheWrite1h,
    cache_write_1h_tokens: cacheWrite1h,
    reasoning_tokens: reasoning,
    duration_ms: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : undefined,
    cost_reported_usd: reported,
    raw,
  };
  if (!key) return { row, session: null };
  return {
    row,
    session: {
      key,
      parentKey: parentSessionKey(r),
      ts: Date.parse(ts),
      lane,
      laneDetail: detail,
      billing,
      account,
      apiKey,
      machine,
      model,
      effort,
      repo,
      issueId,
      runId,
    },
  };
}

/** jsonb rejects U+0000 in strings; no collector text needs it. */
const payload = (rows: unknown[]): string => JSON.stringify(rows).replace(/\\u0000/g, "");

// Content columns of usage.records: written on conflict only when one of them differs, so ingested_at moves on real change.
const CONTENT = [
  "grain", "ts", "session_id", "model_raw", "model", "repo", "project_raw", "workspace", "billing", "account", "api_key",
  "machine", "outcome", "lane", "lane_detail", "effort", "issue_id", "run_id", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens", "reasoning_tokens", "duration_ms",
  "cost_reported_usd", "cost_usd", "cost_source", "price_id", "raw",
] as const;
const excluded = CONTENT.map((c) => `EXCLUDED.${c}`).join(", ");
const current = CONTENT.map((c) => `t.${c}`).join(", ");
const assign = CONTENT.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

const RECORDS_SQL = `
WITH up AS (
  INSERT INTO usage.records AS t
    (source, source_id, ${CONTENT.join(", ")}, ingested_at)
  SELECT $2::text, r.source_id, r.grain, r.ts, s.id, r.model_raw, r.model, r.repo, r.project_raw, r.workspace, r.billing,
         r.account, r.api_key, r.machine, r.outcome, r.lane, r.lane_detail, r.effort, r.issue_id, r.run_id,
         r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
         r.reasoning_tokens, r.duration_ms, r.cost_reported_usd, c.cost_usd, c.cost_source, c.price_id, r.raw,
         coalesce($3::timestamptz, now())
  FROM jsonb_to_recordset($1::text::jsonb) AS r(
         source_id text, grain text, ts timestamptz, session_key text, model_raw text, model text, repo text,
         project_raw text, workspace text, billing text, account text, api_key text, machine text, outcome text,
         lane text, lane_detail jsonb, effort text, issue_id text, run_id text, input_tokens bigint, output_tokens bigint,
         cache_read_tokens bigint, cache_write_5m_tokens bigint, cache_write_1h_tokens bigint, reasoning_tokens bigint,
         duration_ms integer, cost_reported_usd numeric, raw jsonb)
  LEFT JOIN usage.sessions s ON s.source = $2::text AND s.source_session_id = r.session_key
  CROSS JOIN LATERAL usage.compute_cost(r.model, r.ts, r.input_tokens, r.output_tokens, r.cache_read_tokens,
         r.cache_write_5m_tokens, r.cache_write_1h_tokens, r.reasoning_tokens, r.grain, r.cost_reported_usd) AS c
  ORDER BY r.source_id
  ON CONFLICT (source, source_id) DO UPDATE SET ${assign}, ingested_at = EXCLUDED.ingested_at
  WHERE (${current}) IS DISTINCT FROM (${excluded})
  RETURNING (xmax = 0) AS inserted
)
SELECT count(*) FILTER (WHERE inserted)::int AS inserted, count(*)::int AS written FROM up`;

// An incoming batch is "earlier" when it starts at or before the stored session: then its attributes win over the
// stored ones, otherwise the stored ones do. Either way a NULL never erases a value (that is the inner coalesce).
const EARLIER = "(s.first_ts IS NULL OR EXCLUDED.first_ts <= s.first_ts)";
const merge = (col: string): string =>
  `CASE WHEN ${EARLIER} THEN coalesce(EXCLUDED.${col}, s.${col}) ELSE coalesce(s.${col}, EXCLUDED.${col}) END`;
// The lane changes only when the batch has a non-subagent lane and is earlier, or the stored lane is `subagent`
// (a session first seen through its subagent requests alone): a subagent record never demotes an interactive session.
const TAKE_LANE = `(EXCLUDED.lane <> 'subagent' AND (s.lane = 'subagent' OR ${EARLIER}))`;

const SESSIONS_SQL = `
INSERT INTO usage.sessions AS s
  (source, source_session_id, lane, lane_detail, account, billing, api_key, machine, model, effort, repo, issue_id, run_id,
   first_ts, last_ts)
SELECT $2::text, j.source_session_id, j.lane, j.lane_detail, j.account, j.billing, j.api_key, j.machine, j.model, j.effort,
       j.repo, j.issue_id, j.run_id, j.first_ts, j.last_ts
FROM jsonb_to_recordset($1::text::jsonb) AS j(
       source_session_id text, lane text, lane_detail jsonb, account text, billing text, api_key text, machine text,
       model text, effort text, repo text, issue_id text, run_id text, first_ts timestamptz, last_ts timestamptz)
ORDER BY j.source_session_id
ON CONFLICT (source, source_session_id) DO UPDATE SET
  lane = CASE WHEN ${TAKE_LANE} THEN EXCLUDED.lane ELSE s.lane END,
  lane_detail = CASE WHEN ${TAKE_LANE} THEN EXCLUDED.lane_detail ELSE s.lane_detail END,
  account = ${merge("account")},
  billing = coalesce(CASE WHEN ${EARLIER}
                          THEN coalesce(nullif(EXCLUDED.billing, 'unknown'), nullif(s.billing, 'unknown'))
                          ELSE coalesce(nullif(s.billing, 'unknown'), nullif(EXCLUDED.billing, 'unknown')) END, 'unknown'),
  api_key = ${merge("api_key")},
  machine = ${merge("machine")},
  model = ${merge("model")},
  effort = ${merge("effort")},
  repo = ${merge("repo")},
  issue_id = ${merge("issue_id")},
  run_id = ${merge("run_id")},
  first_ts = least(s.first_ts, EXCLUDED.first_ts),
  last_ts = greatest(s.last_ts, EXCLUDED.last_ts)`;

// Parents resolve after the sessions exist (a parent can sit in the same batch); a link is never erased or invented.
const PARENTS_SQL = `
UPDATE usage.sessions c SET parent_session_id = p.id
FROM jsonb_to_recordset($1::text::jsonb) AS j(source_session_id text, parent_key text), usage.sessions p
WHERE c.source = $2::text AND c.source_session_id = j.source_session_id
  AND p.source = $2::text AND p.source_session_id = j.parent_key
  AND c.parent_session_id IS DISTINCT FROM p.id`;

/**
 * Upsert a batch of records of one source into usage.records, and their sessions into usage.sessions.
 *
 * Idempotent on (source, source_id); the conflict branch fires only when a content column differs (NULL-safe), so
 * `ingested_at` moves on real change only. Safe from several processes at once: pure INSERT ... ON CONFLICT with
 * sorted lock order, no read-modify-write (session merges run inside the ON CONFLICT clause). Each chunk of 500 is one
 * transaction (sessions, then records), so a failed chunk leaves earlier chunks in place and a re-run converges.
 * Duplicate source ids inside one call keep the last, as sequential SQLite upserts did. A record whose `ts` is not a
 * date is skipped with a warning (it cannot be stored). `processed` counts the records passed in.
 *
 * Cost, cost_source and price_id come from usage.compute_cost at write time; this function prices nothing itself.
 * Billing and account lookups read the batch's session_env lines from usage.session_env.
 */
export async function upsertRecords(
  sql: SQL,
  source: string,
  records: UsageRecord[],
  opts: WriteOptions = {},
): Promise<WriteSummary> {
  const bySourceId = new Map<string, UsageRecord>();
  for (const r of records) {
    if (Number.isNaN(Date.parse(r.ts))) {
      log.warn(`pg-writer: ${source}/${r.sourceId} skipped, ts ${JSON.stringify(r.ts)} is not a date`);
      continue;
    }
    bySourceId.set(r.sourceId, r);
  }
  const unique = [...bySourceId.values()];
  const batchMachine = currentMachine();
  const now = opts.now ? opts.now.toISOString() : null;
  let newRows = 0;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const sessionIds = chunk.map((r) => str(r.raw?.sessionId)).filter((s): s is string => s !== null);
    const env = sessionEnvLookups(await readSessionEnv(sql, sessionIds));

    const rows: Row[] = [];
    const inputs: SessionInput[] = [];
    for (const r of chunk) {
      const { row, session } = toRow(source, r, opts, r.machine ?? batchMachine, env);
      rows.push(row);
      if (session) inputs.push(session);
    }
    const sessions = aggregateSessions(inputs);

    const inserted = await sql.begin(async (tx) => {
      if (sessions.length > 0) {
        await tx.unsafe(SESSIONS_SQL, [payload(sessions.map((s) => ({ ...s, lane_detail: s.lane_detail ?? undefined }))), source]);
        const linked = sessions.filter((s) => s.parent_key);
        if (linked.length > 0) {
          await tx.unsafe(PARENTS_SQL, [payload(linked.map((s) => ({ source_session_id: s.source_session_id, parent_key: s.parent_key }))), source]);
        }
      }
      const [counts] = await tx.unsafe(RECORDS_SQL, [payload(rows), source, now]);
      return Number(counts.inserted);
    });
    newRows += inserted;
  }
  return { processed: records.length, newRows };
}
