import type { Database } from "bun:sqlite";
import { loadCursor, saveState, upsertRecords } from "./db.ts";
import { collectors as allCollectors } from "./collectors/index.ts";
import { log } from "./log.ts";
import { unpricedByModel, type UnpricedModel } from "./report.ts";
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
}

export interface IngestOptions {
  full?: boolean;
  /** Limit the run to a single source. */
  only?: string;
}

/**
 * Run every available collector. Each is isolated: an unavailable source is
 * skipped, and a thrown error is caught and recorded so one broken source never
 * aborts the others.
 */
export async function runIngest(db: Database, opts: IngestOptions = {}): Promise<IngestSummary> {
  const targets = opts.only
    ? allCollectors.filter((c) => c.source === opts.only)
    : allCollectors;

  if (opts.only && targets.length === 0) {
    throw new Error(`unknown source "${opts.only}"`);
  }

  const results: SourceResult[] = [];
  for (const c of targets) {
    results.push(await runOne(db, c, opts));
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

  const unpriced = unpricedByModel(db);
  return { results, synced, unpriced };
}

/**
 * One line per run, the last thing written to the log — a grep-able human
 * summary, not the liveness signal: the heartbeat reads the log's mtime, which
 * the per-source lines above already move. Fixed shape, one token per source:
 *
 *   run 2026-09-07T15:07:39.146Z status=ok claude-code=+12/40 hermes=+0/2413 … sync=12 unpriced=0
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
  return `run ${now.toISOString()} status=${status} ${perSource.join(" ")} sync=${summary.synced} unpriced=${unpricedTotal}`;
}

async function runOne(db: Database, c: Collector, opts: IngestOptions): Promise<SourceResult> {
  if (!c.available()) {
    return { source: c.source, status: "skipped", processed: 0, newRows: 0, note: "not present" };
  }

  try {
    const result = await c.collect({
      cursor: opts.full ? null : loadCursor(db, c.source),
      full: opts.full ?? false,
      log,
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
