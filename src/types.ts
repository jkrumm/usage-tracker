// Shared contracts for the usage tracker.
//
// A "usage record" is one billable unit from one source. The grain differs by
// source — Claude Code emits one record per assistant message, the agents emit
// one record per session — but every record normalizes to the same shape so a
// single table and a single set of queries cover all of them.

export type Billing = "max" | "iu" | "iu-direct" | "anthropic-api" | "unknown";
export type Workspace = "work" | "private";
export type Grain = "message" | "session";
export type Outcome = "ok" | "error";

/**
 * A normalized usage record. Collectors produce these knowing only tokens —
 * model normalization, billing classification and cost are derived centrally
 * at insert time (see db.ts), so a new source never re-implements pricing.
 */
export interface UsageRecord {
  /** Stable source-local id used for dedup (requestId, session id, …). */
  sourceId: string;
  grain: Grain;
  /** Event time as ISO 8601 UTC. */
  ts: string;
  /** Raw model string exactly as the source recorded it (may be JSON). */
  model: string | null;
  /** Project / workspace / channel context, source-specific. */
  project: string | null;
  /**
   * Optional per-record workspace override. Collectors that are pinned to a
   * single workspace (hermes, feuer, …) declare it on the Collector and let
   * upsertRecords stamp it; per-record path-based classification on the Argo
   * side handles claude-code/litellm where the cwd determines workspace.
   */
  workspace?: Workspace | null;
  /**
   * Sub-tool / action that triggered the request, where the source can attribute
   * it — e.g. "check", "review:angle", "implement" for sideclaw-attributed rows.
   * Null when the source doesn't expose this granularity.
   */
  subTool?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Request/session latency in milliseconds when the source reports it. */
  durationMs?: number | null;
  /**
   * Request outcome. Defaults to "ok"; sources that observe failures (the
   * LiteLLM bridge) emit zero-token "error" rows so the error rate is queryable.
   */
  outcome?: Outcome;
  /** Optional source-specific extras, persisted as JSON for later inspection. */
  raw?: Record<string, unknown>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface CollectContext {
  /** The watermark this collector persisted on its previous run, or null. */
  cursor: string | null;
  /** When true, ignore the cursor and re-scan everything. */
  full: boolean;
  log: Logger;
}

export interface CollectResult {
  records: UsageRecord[];
  /** New watermark to persist for the next run. Echo the old one if unused. */
  cursor: string | null;
  /** Human-readable note surfaced in the ingest summary (e.g. skip reason). */
  note?: string;
}

export interface Collector {
  /** Stable source key — also the value stored in usage_record.source. */
  readonly source: string;
  /**
   * Workspace the collector emits when records don't carry one of their own.
   * Set when the daemon is pinned to a workspace (hermes/feuer/opencode);
   * omit when the workspace is per-record and Argo derives it
   * from the cwd (claude-code, litellm).
   */
  readonly workspace?: Workspace | null;
  /** Cheap check: is this source present on this machine at all? */
  available(): boolean;
  collect(ctx: CollectContext): Promise<CollectResult>;
}
