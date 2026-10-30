import type { Billing, Grain, Outcome, Workspace } from "./types.ts";
import type { WriterRecord } from "./pg/writer.ts";

// Pure logic of the one-off history backfill (scripts/backfill-argo.ts): a legacy `usage_record` row, from the local
// SQLite archive or from Argo's table, to the record the Postgres writer takes, and which of several rows with one
// (source, source_id) wins. No I/O here; the script owns the dump, the union and the writes.

/** A legacy usage_record row in one shape for both stores. Argo has no 1h split (0) and a float4 cost. */
export interface StoredRow {
  /** Argo's serial id (tie-break between rows of one key); absent for SQLite rows. */
  id?: number;
  source: string;
  sourceId: string;
  grain: string;
  ts: string;
  model: string | null;
  modelNorm: string | null;
  project: string | null;
  billing: string;
  machine: string | null;
  outcome: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  costSource: string;
  /** SQLite stores JSON text, Argo hands over the parsed jsonb. */
  raw: string | Record<string, unknown> | null;
  ingestedAt: string;
  subTool: string | null;
  durationMs: number | null;
  workspace: string | null;
  account: string | null;
  iuKey: string | null;
}

const BILLINGS: ReadonlySet<string> = new Set(["max", "iu", "anthropic-api", "unknown"]);

/** The stored billing class in the writer's input vocabulary; anything outside it (Argo's `openrouter`) is `unknown`. */
export function storedBilling(billing: string): Billing {
  return BILLINGS.has(billing) ? (billing as Billing) : "unknown";
}

/**
 * Legacy grains: `request` (the retired gateways, one HTTP request) is a message, `step` (an agent-workflows step, which
 * sums its requests) is a session-grain row so tiered prices do not apply to it. Anything else is rejected.
 */
export function storedGrain(grain: string): Grain | null {
  switch (grain) {
    case "message":
    case "request":
      return "message";
    case "session":
    case "step":
      return "session";
    default:
      return null;
  }
}

export function parseRaw(raw: StoredRow["raw"]): { raw: Record<string, unknown> | undefined; malformed: boolean } {
  if (raw === null || raw === undefined) return { raw: undefined, malformed: false };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { raw: undefined, malformed: true };
    }
  }
  if (value === null) return { raw: undefined, malformed: false };
  if (typeof value !== "object" || Array.isArray(value)) return { raw: { legacyRaw: value }, malformed: true };
  return { raw: value as Record<string, unknown>, malformed: false };
}

export type Mapped = { record: WriterRecord; malformedRaw: boolean } | { skip: "ts" | "grain"; detail: string };

/**
 * One stored row to a writer record. Billing, account and IU key are taken as stored (`preclassified`): they were
 * classified while the session_env logs still existed and the writer must not re-derive them. A cost stored with
 * `cost_source = 'reported'` is passed as the provider-reported cost (the writer drops it for IGNORE_REPORTED_COST
 * models); every other row is priced by usage.compute_cost at write time.
 */
export function toRecord(row: StoredRow): Mapped {
  if (Number.isNaN(Date.parse(row.ts))) return { skip: "ts", detail: row.ts };
  const grain = storedGrain(row.grain);
  if (!grain) return { skip: "grain", detail: row.grain };
  const { raw, malformed } = parseRaw(row.raw);
  const reported = row.costSource === "reported" && row.costUsd !== null && Number.isFinite(row.costUsd);
  const workspace: Workspace | undefined = row.workspace === "work" || row.workspace === "private" ? row.workspace : undefined;
  const outcome: Outcome = row.outcome === "error" ? "error" : "ok";
  const record: WriterRecord = {
    sourceId: row.sourceId,
    grain,
    ts: row.ts,
    model: row.model,
    project: row.project,
    workspace,
    subTool: row.subTool,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    reasoningTokens: row.reasoningTokens,
    durationMs: row.durationMs,
    authoritativeCostUsd: reported ? row.costUsd : undefined,
    outcome,
    raw,
    preclassified: {
      billing: storedBilling(row.billing),
      account: row.account,
      iuKey: row.iuKey,
      machine: row.machine,
    },
  };
  return { record, malformedRaw: malformed };
}

/**
 * Which of several Argo rows with one (source, source_id) survives: the one on the same machine as the SQLite row,
 * else the most recently ingested, else the highest serial id. Deterministic for any input order.
 */
export function pickArgoRow(rows: readonly StoredRow[], sqliteMachine: string | null): StoredRow {
  let best = rows[0] as StoredRow;
  const rank = (r: StoredRow): [number, string, number] => [sqliteMachine !== null && r.machine === sqliteMachine ? 1 : 0, r.ingestedAt, r.id ?? 0];
  for (const r of rows.slice(1)) {
    const [a1, a2, a3] = rank(r);
    const [b1, b2, b3] = rank(best);
    if (a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 > b3) best = r;
  }
  return best;
}

export interface Chosen {
  origin: "sqlite" | "argo";
  /** The row that is written (for `sqlite`, with Argo's value filled into fields SQLite left empty). */
  row: StoredRow;
  /** The Argo row that survived dedup, if the key exists in Argo. */
  argo: StoredRow | null;
  /** Argo rows of this key that were dropped (same key, other machine or re-post). */
  dropped: StoredRow[];
  /** Fields SQLite had empty that Argo's surviving row supplied. */
  borrowed: Array<"workspace" | "subTool" | "account" | "iuKey">;
}

/**
 * The union rule for one key. SQLite wins when it has the key (exact cost, 1h split, IU key); Argo's surviving row is the
 * fallback. Where SQLite left workspace / sub_tool / account / iu_key empty and Argo derived one, Argo's value fills in:
 * SQLite never stored the workspace Argo classified by path, and a NULL there is a gap, not a statement.
 */
export function chooseRow(argoRows: readonly StoredRow[], sqlite: StoredRow | undefined): Chosen | null {
  if (argoRows.length === 0 && !sqlite) return null;
  const argo = argoRows.length > 0 ? pickArgoRow(argoRows, sqlite?.machine ?? null) : null;
  const dropped = argo ? argoRows.filter((r) => r !== argo) : [];
  if (!sqlite) return { origin: "argo", row: argo as StoredRow, argo, dropped, borrowed: [] };
  const row: StoredRow = { ...sqlite };
  const borrowed: Chosen["borrowed"] = [];
  for (const f of ["workspace", "subTool", "account", "iuKey"] as const) {
    if (row[f] === null && argo && argo[f] !== null) {
      row[f] = argo[f];
      borrowed.push(f);
    }
  }
  return { origin: "sqlite", row, argo, dropped, borrowed };
}

/** UTC calendar month of an ISO timestamp, `YYYY-MM`. */
export function monthOf(ts: string): string {
  return new Date(ts).toISOString().slice(0, 7);
}
