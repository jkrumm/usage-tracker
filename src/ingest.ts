import type { Database } from "bun:sqlite";
import { loadCursor, saveState, upsertRecords } from "./db.ts";
import { collectors as allCollectors } from "./collectors/index.ts";
import { log } from "./log.ts";
import { sync } from "./sync.ts";
import type { Collector } from "./types.ts";

export interface SourceResult {
  source: string;
  status: "ok" | "skipped" | "error";
  processed: number;
  newRows: number;
  note?: string;
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
export async function runIngest(db: Database, opts: IngestOptions = {}): Promise<SourceResult[]> {
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

  try {
    const { pushed, batches } = await sync(db);
    if (pushed > 0) {
      log.info(`sync: pushed ${pushed} records in ${batches} batch${batches === 1 ? "" : "es"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`sync: ${msg}`);
  }

  return results;
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
    const { processed, newRows } = upsertRecords(db, c.source, result.records);

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
