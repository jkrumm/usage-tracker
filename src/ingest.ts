import type { SQL } from "bun";
import { collectPicks } from "./collectors/account-picks.ts";
import { collectQuota } from "./collectors/claude-quota.ts";
import { collectPortal, type PortalFetcher } from "./collectors/iu-portal.ts";
import { collectors as allCollectors } from "./collectors/index.ts";
import { log } from "./log.ts";
import { markSessionEnvsPersisted, pendingSessionEnvs, useStoredSessionEnvs } from "./models.ts";
import { upsertSessionEnv } from "./pg/session-env.ts";
import { loadCursor, loadSessionEnvTable, saveState } from "./pg/state.ts";
import { upsertRecords } from "./pg/writer.ts";
import { unpricedByModel, type UnpricedModel } from "./report.ts";
import { syncIumac } from "./remote.ts";
import type { SyncResult } from "./remote.ts";
import type { Collector } from "./types.ts";

export interface SourceResult {
  source: string;
  status: "ok" | "skipped" | "error";
  processed: number;
  newRows: number;
  note?: string;
}

export interface IngestSummary {
  results: SourceResult[];
  /** Rows priced at nothing (cost_source = 'none'), by model — an unknown
   * model id is otherwise indistinguishable from a genuinely free one. */
  unpriced: UnpricedModel[];
  /** New quota_samples / account_picks rows this run. */
  quota: number;
  picks: number;
  /** IU portal cost cells written this run (0 when throttled, unreachable or failed). */
  portal: number;
}

export interface IngestOptions {
  full?: boolean;
  /** Limit the run to a single source. */
  only?: string;
  /** Replace the collector registry (tests). */
  collectors?: Collector[];
  /** Replace the iumac mirror sync (tests). */
  syncIumac?: () => Promise<SyncResult>;
  /** Collect quota samples + picker decisions (default: on unless `only` or `collectors` narrows the run). */
  accounts?: boolean;
  /** Fetch the IU portal cost report (default: same condition as `accounts`). */
  portal?: boolean;
  /** Replace the ssh scrape (tests). */
  portalFetch?: PortalFetcher;
}

/**
 * Run every available collector into Postgres. Each is isolated: an unavailable
 * source is skipped, and a thrown error is caught and recorded so one broken
 * source never aborts the others. Cursors and run bookkeeping live in
 * usage.collector_state.
 *
 * Known limitation: a collector's cursor is saved after its whole batch is written, not per batch. A run killed at
 * jobrun's 600 s deadline mid-collector therefore restarts that collector's scan from the old cursor on the next tick
 * (the upsert is idempotent, so nothing is lost or doubled, the scan is only repeated). A per-batch cursor is a later
 * improvement.
 */
export async function runIngest(sql: SQL, opts: IngestOptions = {}): Promise<IngestSummary> {
  const registry = opts.collectors ?? allCollectors;
  const targets = opts.only ? registry.filter((c) => c.source === opts.only) : registry;

  if (opts.only && targets.length === 0) {
    throw new Error(`unknown source "${opts.only}"`);
  }

  // The stored session_env lines are the baseline of the hook-log lookups, so a
  // long-lived session keeps its lane and base_url after the log files are
  // pruned. The log scan itself stays lazy: nothing is read until the first
  // lookup, which lands after claude-code has synced the iumac mirror.
  useStoredSessionEnvs(await loadSessionEnvTable(sql));

  const iumacSync = once(opts.syncIumac ?? (() => syncIumac(log)));
  const results: SourceResult[] = [];
  for (const c of targets) {
    results.push(await runOne(sql, c, opts, iumacSync));
  }

  let quota = 0;
  let picks = 0;
  if (opts.accounts ?? (!opts.only && !opts.collectors)) {
    try {
      quota = await collectQuota(sql);
    } catch (err) {
      log.error(`claude-quota: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      picks = await collectPicks(sql, { full: opts.full });
    } catch (err) {
      log.error(`account-picks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Last: a slow or hung portal scrape must never starve the record collectors.
  let portal = 0;
  if (opts.portal ?? (!opts.only && !opts.collectors)) {
    try {
      portal = await collectPortal(sql, { fetch: opts.portalFetch });
    } catch (err) {
      log.error(`iu-portal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let unpriced: UnpricedModel[] = [];
  try {
    unpriced = await unpricedByModel(sql);
  } catch (err) {
    log.error(`unpriced: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { results, unpriced, quota, picks, portal };
}

/**
 * One line per run, the last thing written to the log — a grep-able human
 * summary, not the liveness signal: the heartbeat reads the log's mtime, which
 * the per-source lines above already move. Fixed shape, one token per source:
 *
 *   run 2026-09-07T15:07:39.146Z status=ok claude-code=+12/40 hermes=+0/2413 … quota=+1 picks=+3 portal=+0 unpriced=0
 *
 * `+new/seen` mirrors the per-source lines above it; a skipped or errored
 * source shows its status instead of counts. `unpriced` is the total row count
 * across every model with `cost_source = 'none'` (whole table, not just this
 * run) — a nonzero value means some model id has no price; `make sources`
 * has the per-model breakdown.
 */
export function formatRunSummary(summary: IngestSummary, now = new Date()): string {
  const status = summary.results.some((r) => r.status === "error") ? "error" : "ok";
  const perSource = summary.results.map((r) =>
    r.status === "ok" ? `${r.source}=+${r.newRows}/${r.processed}` : `${r.source}=${r.status}`,
  );
  const unpricedTotal = summary.unpriced.reduce((sum, m) => sum + m.rows, 0);
  return `run ${now.toISOString()} status=${status} ${perSource.join(" ")} quota=+${summary.quota} picks=+${summary.picks} portal=+${summary.portal} unpriced=${unpricedTotal}`;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= fn());
}

/**
 * Write the hook-log session_env lines that are new or changed into
 * usage.session_env. Runs after a collector and BEFORE the writer, so the
 * writer's billing / account lookups (read from the table) see the lines of the
 * batch it is about to write.
 */
async function persistSessionEnv(sql: SQL): Promise<void> {
  const changes = pendingSessionEnvs();
  if (changes.length === 0) return;
  await upsertSessionEnv(sql, changes);
  markSessionEnvsPersisted(changes);
}

async function runOne(
  sql: SQL,
  c: Collector,
  opts: IngestOptions,
  syncIumac: () => Promise<SyncResult>,
): Promise<SourceResult> {
  if (!c.available()) {
    return { source: c.source, status: "skipped", processed: 0, newRows: 0, note: "not present" };
  }

  try {
    const result = await c.collect({
      cursor: opts.full ? null : await loadCursor(sql, c.source),
      full: opts.full ?? false,
      log,
      syncIumac,
    });
    await persistSessionEnv(sql);
    const { processed, newRows } = await upsertRecords(sql, c.source, result.records, {
      defaultWorkspace: c.workspace ?? null,
    });

    const status = result.note && result.records.length === 0 ? "skipped" : "ok";
    await saveState(sql, c.source, { cursor: result.cursor, status, note: result.note });
    return { source: c.source, status, processed, newRows, note: result.note };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${c.source}: ${msg}`);
    // The stored cursor stays: the next run retries from the same watermark. When Postgres itself is the failure the
    // bookkeeping write fails too; that must not escape and abort the collectors after this one.
    try {
      await saveState(sql, c.source, { status: "error", note: msg });
    } catch (stateErr) {
      log.error(`${c.source}: could not record the error: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`);
    }
    return { source: c.source, status: "error", processed: 0, newRows: 0, note: msg };
  }
}
