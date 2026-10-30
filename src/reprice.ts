import type { SQL } from "bun";

/**
 * Re-cost already-ingested rows against the prices in force now (usage.prices, usage.price_overrides).
 *
 * The writer prices a row once, at write time, and the collectors are incremental, so a price correction
 * (a sync that backfilled history, a new override) only reaches rows a collector happens to re-read. This
 * rewrites every row whose cost `usage.compute_cost` now disagrees with, in one set-based UPDATE.
 *
 * - A provider-reported row (`cost_reported_usd IS NOT NULL`) is never touched: compute_cost has no way to
 *   reproduce a per-call vendor bill from tokens, so recomputing would replace a real cost with a list-price guess.
 *   (`sonar` is the IU exception, and the writer already stores it without `cost_reported_usd`, so tokens price it.)
 * - A row the prices cannot cover now is left as it is. Prices vanish when a model leaves the catalog, which
 *   means the table forgot the model, not that those calls were free: repricing only moves a row between two
 *   known prices (or prices a row that had none).
 * - The stored token columns are the input, so `reasoning_tokens` is already 0 for the rows IU billed no reasoning
 *   on (`REASONING_FREE_BEFORE` in the writer, the count kept in `raw.reasoningTokensUnbilled`) and stays so.
 * - `ingested_at` is left alone: a reprice is not an ingest.
 */

export interface RepriceOptions {
  /** Only rows with this `model`. Omit for the whole table. */
  model?: string | undefined;
  /** Report what would change without writing. */
  dryRun?: boolean | undefined;
}

export interface RepriceModelSummary {
  model: string;
  /** Rows whose cost, source or price row changes. */
  changed: number;
  oldCostUsd: number;
  newCostUsd: number;
}

export interface RepriceResult {
  /** Rows compared: everything that is not provider-reported. */
  scanned: number;
  changed: number;
  /** Priced rows whose model has no price today: deliberately left untouched. */
  preserved: number;
  /** Rows with a provider-reported cost (`cost_reported_usd`): never recomputed. */
  reportedSkipped: number;
  dryRun: boolean;
  models: RepriceModelSummary[];
}

/** Sub-cent noise from a float round trip (a backfill) is not a change. */
const EPSILON = 1e-9;

// One statement. `calc` prices every candidate through compute_cost, `diff` keeps the rows that move, `upd` writes
// them (a data-modifying CTE always runs, so the dry run gates it with $2), the final SELECT reports from `diff`.
const REPRICE_SQL = `
WITH calc AS (
  SELECT r.id, r.model,
         r.cost_usd AS old_usd, r.cost_source AS old_source, r.price_id AS old_price,
         c.cost_usd AS new_usd, c.cost_source AS new_source, c.price_id AS new_price
  FROM usage.records r
  CROSS JOIN LATERAL usage.compute_cost(r.model, r.ts, r.input_tokens, r.output_tokens, r.cache_read_tokens,
         r.cache_write_5m_tokens, r.cache_write_1h_tokens, r.reasoning_tokens, r.grain, NULL) AS c
  WHERE r.cost_reported_usd IS NULL AND ($1::text IS NULL OR r.model = $1::text)
), diff AS (
  SELECT * FROM calc
  WHERE new_usd IS NOT NULL
    AND (old_usd IS NULL OR abs(new_usd - old_usd) > ${EPSILON}
         OR new_source IS DISTINCT FROM old_source OR new_price IS DISTINCT FROM old_price)
), upd AS (
  UPDATE usage.records r
  SET cost_usd = d.new_usd, cost_source = d.new_source, price_id = d.new_price
  FROM diff d
  WHERE r.id = d.id AND NOT $2::boolean
  RETURNING r.id
), per_model AS (
  SELECT coalesce(model, '(unknown)') AS model, count(*)::int AS changed,
         sum(coalesce(old_usd, 0))::float8 AS "oldCostUsd", sum(new_usd)::float8 AS "newCostUsd"
  FROM diff GROUP BY 1
)
SELECT (SELECT count(*) FROM calc)::int AS scanned,
       (SELECT count(*) FROM calc WHERE new_usd IS NULL AND old_usd IS NOT NULL)::int AS preserved,
       (SELECT count(*) FROM usage.records WHERE cost_reported_usd IS NOT NULL AND ($1::text IS NULL OR model = $1::text))::int AS reported,
       coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY abs(p."newCostUsd" - p."oldCostUsd") DESC, p.model) FROM per_model p), '[]'::jsonb) AS models`;

export async function reprice(sql: SQL, opts: RepriceOptions = {}): Promise<RepriceResult> {
  const dryRun = opts.dryRun ?? false;
  const [row] = await sql.unsafe(REPRICE_SQL, [opts.model ?? null, dryRun]);
  const models = (typeof row.models === "string" ? JSON.parse(row.models) : row.models) as RepriceModelSummary[];
  return {
    scanned: row.scanned,
    changed: models.reduce((n, m) => n + m.changed, 0),
    preserved: row.preserved,
    reportedSkipped: row.reported,
    dryRun,
    models,
  };
}

export function formatReprice(result: RepriceResult): string {
  const preservedNote =
    result.preserved > 0 ? `\n${result.preserved} priced rows kept as-is: their model has no price today` : "";
  const reportedNote =
    result.reportedSkipped > 0
      ? `\n${result.reportedSkipped} rows kept as-is: provider-reported cost (cost_reported_usd)`
      : "";
  if (result.changed === 0) {
    return `reprice: ${result.scanned} rows scanned, everything already matches the current prices${preservedNote}${reportedNote}`;
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
      (result.dryRun ? " (dry run — nothing written)" : "") +
      preservedNote +
      reportedNote,
  );
  return lines.join("\n");
}
