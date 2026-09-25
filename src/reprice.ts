import type { Database } from "bun:sqlite";
import { computeCost } from "./pricing.ts";
import type { Grain } from "./types.ts";

/**
 * Re-cost already-ingested rows against the current PRICING table.
 *
 * Ingest prices a row once, at write time, and the collectors are incremental —
 * so a rate correction only reaches rows a collector happens to re-read. Every
 * older row keeps the price that was current when it landed, which silently
 * skews any historical report. This walks the table and rewrites the rows whose
 * cost the current table disagrees with.
 *
 * Repriced rows get `synced_at = NULL` so the next `sync` re-pushes them: Argo
 * holds its own copy of `cost_usd`, and a local-only fix would leave the two
 * disagreeing.
 *
 * A vendor-reported row (`cost_source = 'reported'`) is skipped outright —
 * that cost came from the vendor, not from our table.
 *
 * A row the current table cannot price is left exactly as it is. Rates get
 * *removed* from PRICING when a collector is retired (the audio-proxy models
 * went that way), so "no entry today" means the table forgot the model, not
 * that those calls were free — rewriting them to NULL would destroy real
 * historical cost. Repricing only ever moves a row between two known prices.
 */

interface RepriceRow {
  id: number;
  model_norm: string | null;
  grain: Grain;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_source: string;
}

export interface RepriceOptions {
  /** Only rows with this `model_norm`. Omit for the whole table. */
  model?: string | undefined;
  /** Report what would change without writing. */
  dryRun?: boolean | undefined;
}

export interface RepriceModelSummary {
  model: string;
  rows: number;
  changed: number;
  oldCostUsd: number;
  newCostUsd: number;
}

export interface RepriceResult {
  scanned: number;
  changed: number;
  /** Priced rows whose model has no rate today — deliberately left untouched. */
  preserved: number;
  dryRun: boolean;
  models: RepriceModelSummary[];
}

/** A float round-trip through SQLite is not bit-exact; ignore sub-cent noise. */
const EPSILON = 1e-9;

export function reprice(db: Database, opts: RepriceOptions = {}): RepriceResult {
  const dryRun = opts.dryRun ?? false;
  const where = opts.model ? "WHERE model_norm = ?" : "";
  const params = opts.model ? [opts.model] : [];
  const rows = db
    .query<RepriceRow, string[]>(
      `SELECT id, model_norm, grain, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cache_write_1h_tokens, reasoning_tokens,
              cost_usd, cost_source
       FROM usage_record ${where} ORDER BY id`,
    )
    .all(...params);

  const byModel = new Map<string, RepriceModelSummary>();
  const updates: Array<{ id: number; usd: number | null; source: string }> = [];
  let preserved = 0;

  for (const row of rows) {
    // A vendor-reported cost (cost_source 'reported', e.g. research-gateway's
    // sonar rows) is not ours to recompute: the table has no rate for a
    // per-call vendor bill, so leave the row exactly as it landed.
    if (row.cost_source === "reported") continue;

    const cost = computeCost(row.model_norm, {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      cacheWrite1h: row.cache_write_1h_tokens,
      reasoning: row.reasoning_tokens,
      grain: row.grain,
    });

    if (cost.usd === null && row.cost_usd !== null) {
      preserved++;
      continue;
    }

    const key = row.model_norm ?? "(unknown)";
    const summary = byModel.get(key) ?? {
      model: key,
      rows: 0,
      changed: 0,
      oldCostUsd: 0,
      newCostUsd: 0,
    };
    summary.rows++;
    summary.oldCostUsd += row.cost_usd ?? 0;
    summary.newCostUsd += cost.usd ?? 0;

    const costDiffers = Math.abs((cost.usd ?? 0) - (row.cost_usd ?? 0)) > EPSILON;
    const nullnessDiffers = (cost.usd === null) !== (row.cost_usd === null);
    if (costDiffers || nullnessDiffers || cost.source !== row.cost_source) {
      summary.changed++;
      updates.push({ id: row.id, usd: cost.usd, source: cost.source });
    }
    byModel.set(key, summary);
  }

  if (!dryRun && updates.length > 0) {
    const stmt = db.prepare(
      `UPDATE usage_record
       SET cost_usd = $cost_usd, cost_source = $cost_source, synced_at = NULL
       WHERE id = $id`,
    );
    const tx = db.transaction((batch: typeof updates) => {
      for (const u of batch) {
        stmt.run({ $id: u.id, $cost_usd: u.usd, $cost_source: u.source });
      }
    });
    tx(updates);
  }

  return {
    scanned: rows.length,
    changed: updates.length,
    preserved,
    dryRun,
    models: [...byModel.values()]
      .filter((m) => m.changed > 0)
      .sort((a, b) => Math.abs(b.newCostUsd - b.oldCostUsd) - Math.abs(a.newCostUsd - a.oldCostUsd)),
  };
}

export function formatReprice(result: RepriceResult): string {
  const preservedNote =
    result.preserved > 0
      ? `\n${result.preserved} priced rows kept as-is: their model has no rate in the current table`
      : "";
  if (result.changed === 0) {
    return `reprice: ${result.scanned} rows scanned, everything already matches the current rates${preservedNote}`;
  }
  const lines = [
    `${"model".padEnd(24)} ${"rows".padStart(7)} ${"was".padStart(11)} ${"now".padStart(11)} ${"delta".padStart(11)}`,
  ];
  for (const m of result.models) {
    const delta = m.newCostUsd - m.oldCostUsd;
    lines.push(
      `${m.model.padEnd(24)} ${String(m.changed).padStart(7)} ` +
        `${m.oldCostUsd.toFixed(4).padStart(11)} ${m.newCostUsd.toFixed(4).padStart(11)} ` +
        `${(delta >= 0 ? "+" : "") + delta.toFixed(4)}`.padStart(12),
    );
  }
  const verb = result.dryRun ? "would reprice" : "repriced";
  lines.push("");
  lines.push(
    `${verb} ${result.changed} of ${result.scanned} rows` +
      (result.dryRun ? " (dry run — nothing written)" : "; cleared synced_at so `sync` re-pushes them") +
      preservedNote,
  );
  return lines.join("\n");
}
