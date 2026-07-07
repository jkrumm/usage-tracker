import type { Database } from "bun:sqlite";
import { getSessionBaseUrl } from "./models.ts";

// Read-side queries for the CLI. All output is plain aligned text (stdout) so it
// pipes cleanly; no box-drawing.

export type GroupBy = "source" | "model" | "billing" | "day" | "machine" | "sub_tool";

interface StatRow {
  key: string;
  records: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number | null;
}

const GROUP_EXPR: Record<GroupBy, string> = {
  source: "source",
  model: "coalesce(model_norm, '(unknown)')",
  billing: "billing",
  day: "substr(ts, 1, 10)",
  machine: "coalesce(machine, '(unknown)')",
  sub_tool: "coalesce(sub_tool, '(none)')",
};

export function stats(db: Database, opts: { by: GroupBy; sinceDays?: number }): StatRow[] {
  // Error rows carry no tokens and would only dilute counts — keep token/cost
  // aggregates to successful requests; the error rate lives in `sources`.
  const conds = ["outcome = 'ok'"];
  if (opts.sinceDays) {
    conds.push(`ts >= datetime('now', '-${Math.floor(opts.sinceDays)} days')`);
  }
  const where = `WHERE ${conds.join(" AND ")}`;
  return db
    .query<StatRow, []>(
      `SELECT ${GROUP_EXPR[opts.by]} AS key,
              count(*)                  AS records,
              sum(input_tokens)         AS input,
              sum(output_tokens)        AS output,
              sum(cache_read_tokens)    AS cacheRead,
              sum(cache_write_tokens)   AS cacheWrite,
              sum(reasoning_tokens)     AS reasoning,
              sum(cost_usd)             AS costUsd
       FROM usage_record ${where}
       GROUP BY key
       ORDER BY costUsd DESC NULLS LAST, records DESC`,
    )
    .all();
}

export interface SourceStatus {
  source: string;
  records: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastNote: string | null;
  errors: number;
  total: number;
}

export function sourceStatus(db: Database): SourceStatus[] {
  // errors/total come from the rows themselves (LEFT JOIN), so sources that
  // never log failures simply show 0 — only the bridge surfaces a real rate.
  return db
    .query<SourceStatus, []>(
      `SELECT cs.source                              AS source,
              cs.records_total                       AS records,
              cs.last_run_at                         AS lastRunAt,
              cs.last_status                         AS lastStatus,
              cs.last_note                           AS lastNote,
              coalesce(oc.errors, 0)                 AS errors,
              coalesce(oc.total, 0)                  AS total
       FROM collector_state cs
       LEFT JOIN (
         SELECT source,
                sum(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                count(*)                                           AS total
         FROM usage_record
         GROUP BY source
       ) oc ON oc.source = cs.source
       ORDER BY cs.source`,
    )
    .all();
}

export interface BillingAuditRow {
  sessionId: string;
  records: number;
  models: string;
  billings: string;
  costUsd: number | null;
  firstTs: string;
  lastTs: string;
  liveLabel: "expired/missing" | "max (c)" | "iu-direct (ca)";
  multiBilling: boolean;
  mismatch: boolean;
}

interface RawAuditRow {
  sessionId: string;
  records: number;
  models: string | null;
  billings: string | null;
  costUsd: number | null;
  firstTs: string;
  lastTs: string;
}

/**
 * Per-session view over claude-code rows, cross-referenced against the live
 * `session_env` log (`getSessionBaseUrl`) rather than trusting the stored
 * `billing` column alone — that's the whole point of the audit. A session
 * showing more than one distinct `billing` value is a bug post-fix (every row
 * in a session, subagents included, must bill the same way); `mismatch` is
 * only set when the live log can still answer (inside its 3-day retention).
 */
export function sessionBillingAudit(
  db: Database,
  opts: { sinceDays?: number; sessionId?: string } = {},
): BillingAuditRow[] {
  const conds = ["source = 'claude-code'", "json_extract(raw, '$.sessionId') IS NOT NULL"];
  const params: string[] = [];
  if (opts.sinceDays) {
    conds.push(`ts >= datetime('now', '-${Math.floor(opts.sinceDays)} days')`);
  }
  if (opts.sessionId) {
    conds.push("json_extract(raw, '$.sessionId') = ?");
    params.push(opts.sessionId);
  }
  const where = `WHERE ${conds.join(" AND ")}`;
  const rows = db
    .query<RawAuditRow, string[]>(
      `SELECT json_extract(raw, '$.sessionId') AS sessionId,
              count(*)                         AS records,
              group_concat(DISTINCT model_norm) AS models,
              group_concat(DISTINCT billing)    AS billings,
              sum(cost_usd)                     AS costUsd,
              min(ts)                           AS firstTs,
              max(ts)                           AS lastTs
       FROM usage_record ${where}
       GROUP BY sessionId
       ORDER BY lastTs DESC`,
    )
    .all(...params);

  return rows.map((row) => {
    const liveBaseUrl = getSessionBaseUrl(row.sessionId);
    const liveLabel: BillingAuditRow["liveLabel"] =
      liveBaseUrl === undefined ? "expired/missing" : liveBaseUrl ? "iu-direct (ca)" : "max (c)";
    const billingValues = (row.billings ?? "").split(",").filter(Boolean);
    const expected = liveBaseUrl === undefined ? null : liveBaseUrl ? "iu-direct" : "max";
    return {
      sessionId: row.sessionId,
      records: row.records,
      models: row.models ?? "",
      billings: row.billings ?? "",
      costUsd: row.costUsd,
      firstTs: row.firstTs,
      lastTs: row.lastTs,
      liveLabel,
      multiBilling: billingValues.length > 1,
      mismatch: expected != null && !(billingValues.length === 1 && billingValues[0] === expected),
    };
  });
}

// ── formatting ──────────────────────────────────────────────────────────────

export function formatStats(rows: StatRow[], by: GroupBy): string {
  if (rows.length === 0) return "(no data — run `ingest` first)";

  const header = [pad(by, 22), r("records", 9), r("input", 13), r("output", 12), r("cacheR", 13), r("cacheW", 12), r("cost $", 11)];
  const lines = [header.join("  ")];
  lines.push("-".repeat(header.join("  ").length));

  let tCost = 0;
  for (const row of rows) {
    tCost += row.costUsd ?? 0;
    lines.push(
      [
        pad(row.key, 22),
        r(num(row.records), 9),
        r(num(row.input), 13),
        r(num(row.output), 12),
        r(num(row.cacheRead), 13),
        r(num(row.cacheWrite), 12),
        r(row.costUsd == null ? "n/a" : usd(row.costUsd), 11),
      ].join("  "),
    );
  }
  lines.push("-".repeat(header.join("  ").length));
  lines.push(
    [pad("TOTAL", 22), r("", 9), r("", 13), r("", 12), r("", 13), r("", 12), r(usd(tCost), 11)].join("  "),
  );
  return lines.join("\n");
}

export function formatSources(rows: SourceStatus[]): string {
  if (rows.length === 0) return "(no collector state yet — run `ingest`)";
  const lines = [
    [pad("source", 14), r("records", 9), pad("status", 9), r("err%", 7), pad("last run (UTC)", 22), "note"].join("  "),
  ];
  for (const s of rows) {
    lines.push(
      [
        pad(s.source, 14),
        r(num(s.records), 9),
        pad(s.lastStatus ?? "-", 9),
        r(errPct(s), 7),
        pad(s.lastRunAt ?? "-", 22),
        s.lastNote ?? "",
      ].join("  "),
    );
  }
  return lines.join("\n");
}

export function formatBillingAudit(rows: BillingAuditRow[]): string {
  if (rows.length === 0) return "(no claude-code sessions in range)";

  const header = [
    pad("session", 36),
    r("rows", 5),
    pad("models", 24),
    pad("billing", 14),
    pad("live", 15),
    pad("last (UTC)", 20),
    "flags",
  ];
  const lines = [header.join("  ")];
  lines.push("-".repeat(header.join("  ").length));

  let flagged = 0;
  for (const row of rows) {
    const flags = [row.multiBilling && "MULTI-BILLING", row.mismatch && "MISMATCH"].filter(Boolean).join(" ");
    if (flags) flagged++;
    lines.push(
      [
        pad(row.sessionId, 36),
        r(num(row.records), 5),
        pad(row.models, 24),
        pad(row.billings, 14),
        pad(row.liveLabel, 15),
        pad(row.lastTs, 20),
        flags,
      ].join("  "),
    );
  }
  lines.push("-".repeat(header.join("  ").length));
  lines.push(`${rows.length} session${rows.length === 1 ? "" : "s"}, ${flagged} flagged`);
  return lines.join("\n");
}

// "-" when nothing seen yet, "0%" when clean, else one decimal (e.g. "4.2%").
const errPct = (s: SourceStatus): string => {
  if (s.total === 0) return "-";
  if (s.errors === 0) return "0%";
  return `${((s.errors / s.total) * 100).toFixed(1)}%`;
};

const num = (n: number | null) => (n ?? 0).toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(n < 10 ? 4 : 2)}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, Math.max(w, s.length));
const r = (s: string, w: number) => s.padStart(w);
