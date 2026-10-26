import type { Database } from "bun:sqlite";
import { collectPicks } from "./collectors/account-picks.ts";
import { collectQuota } from "./collectors/claude-quota.ts";
import { collectPortal, type PortalFetcher } from "./collectors/iu-portal.ts";
import { loadCursor, saveState, upsertRecords } from "./db.ts";
import { collectors as allCollectors } from "./collectors/index.ts";
import { log } from "./log.ts";
import { useSessionEnvStore } from "./models.ts";
import { unpricedByModel, type UnpricedModel } from "./report.ts";
import { syncIumac } from "./remote.ts";
import type { SyncResult } from "./remote.ts";
import { sync } from "./sync.ts";
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
  /** Rows pushed to Argo at the end of the run (0 when sync is disabled or failed). */
  synced: number;
  /** Rows priced at nothing (cost_source = 'none'), by model — an unknown
   * model id is otherwise indistinguishable from a genuinely free one. */
  unpriced: UnpricedModel[];
  /** New quota_sample / account_pick rows this run. */
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
 * Run every available collector. Each is isolated: an unavailable source is
 * skipped, and a thrown error is caught and recorded so one broken source never
 * aborts the others.
 */
export async function runIngest(db: Database, opts: IngestOptions = {}): Promise<IngestSummary> {
  const registry = opts.collectors ?? allCollectors;
  const targets = opts.only ? registry.filter((c) => c.source === opts.only) : registry;

  if (opts.only && targets.length === 0) {
    throw new Error(`unknown source "${opts.only}"`);
  }

  // Persist session_env lines in the DB so long-lived sessions keep their lane
  // and base_url after the hook's log files are pruned. Lazy: nothing is read
  // until the first lookup, which lands after claude-code has synced the mirror.
  useSessionEnvStore(db);

  const iumacSync = once(opts.syncIumac ?? (() => syncIumac(log)));
  const results: SourceResult[] = [];
  for (const c of targets) {
    results.push(await runOne(db, c, opts, iumacSync));
  }

  let quota = 0;
  let picks = 0;
  if (opts.accounts ?? (!opts.only && !opts.collectors)) {
    try {
      quota = await collectQuota(db);
    } catch (err) {
      log.error(`claude-quota: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      picks = await collectPicks(db, { full: opts.full });
    } catch (err) {
      log.error(`account-picks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let synced = 0;
  try {
    const { pushed, batches } = await sync(db);
    synced = pushed;
    if (pushed > 0) {
      log.info(`sync: pushed ${pushed} records in ${batches} batch${batches === 1 ? "" : "es"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`sync: ${msg}`);
  }

  // After the Argo push: a slow or hung portal scrape must never starve the usage sync.
  let portal = 0;
  if (opts.portal ?? (!opts.only && !opts.collectors)) {
    portal = await collectPortal(db, { fetch: opts.portalFetch });
  }

  const unpriced = unpricedByModel(db);
  return { results, synced, unpriced, quota, picks, portal };
}

/**
 * One line per run, the last thing written to the log — a grep-able human
 * summary, not the liveness signal: the heartbeat reads the log's mtime, which
 * the per-source lines above already move. Fixed shape, one token per source:
 *
 *   run 2026-09-07T15:07:39.146Z status=ok claude-code=+12/40 hermes=+0/2413 … quota=+1 picks=+3 portal=+0 sync=12 unpriced=0
 *
 * `+new/seen` mirrors the per-source lines above it; a skipped or errored
 * source shows its status instead of counts. `unpriced` is the total row count
 * across every model with `cost_source = 'none'` (whole table, not just this
 * run) — a nonzero value means some model id silently costs $0; `make sources`
 * has the per-model breakdown.
 */
export function formatRunSummary(summary: IngestSummary, now = new Date()): string {
  const status = summary.results.some((r) => r.status === "error") ? "error" : "ok";
  const perSource = summary.results.map((r) =>
    r.status === "ok" ? `${r.source}=+${r.newRows}/${r.processed}` : `${r.source}=${r.status}`,
  );
  const unpricedTotal = summary.unpriced.reduce((sum, m) => sum + m.rows, 0);
  return `run ${now.toISOString()} status=${status} ${perSource.join(" ")} quota=+${summary.quota} picks=+${summary.picks} portal=+${summary.portal} sync=${summary.synced} unpriced=${unpricedTotal}`;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= fn());
}

async function runOne(
  db: Database,
  c: Collector,
  opts: IngestOptions,
  syncIumac: () => Promise<SyncResult>,
): Promise<SourceResult> {
  if (!c.available()) {
    return { source: c.source, status: "skipped", processed: 0, newRows: 0, note: "not present" };
  }

  try {
    const result = await c.collect({
      cursor: opts.full ? null : loadCursor(db, c.source),
      full: opts.full ?? false,
      log,
      syncIumac,
    });
    const { processed, newRows } = upsertRecords(db, c.source, result.records, {
      defaultWorkspace: c.workspace ?? null,
    });

    const status = result.note && result.records.length === 0 ? "skipped" : "ok";
    saveState(db, c.source, { result, status, processed });
    return { source: c.source, status, processed, newRows, note: result.note };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${c.source}: ${msg}`);
    saveState(db, c.source, {
      result: { records: [], cursor: loadCursor(db, c.source), note: msg },
      status: "error",
      processed: 0,
    });
    return { source: c.source, status: "error", processed: 0, newRows: 0, note: msg };
  }
}
