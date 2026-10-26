import type { Database } from "bun:sqlite";
import { argoConfig, postJson, type ArgoConfig, type PostResult } from "./argo.ts";
import { loadCursor } from "./db.ts";
import { log } from "./log.ts";

// Push IU's portal cost report to Argo, where the cap, can-spend-today and the
// portal-vs-tracked reconciliation are computed (Argo POST /usage/iu-portal).
//
// The portal re-posts a day as it settles and the 30-day window shifts daily, so a
// new fetch resends the last RESEND_DAYS days, not just the rows that changed. Argo
// upserts on (day, label, row), so a replay is a no-op. The watermark is the newest
// `fetched_at` that reached Argo; it only advances after every batch returned "ok".

const WATERMARK_KEY = "argo_portal_fetched_at";
const PATH = "/usage/iu-portal";
const BATCH = 1000;
const RESEND_DAYS = 35;
const MAX_TOTALS = 24;

interface CostRow {
  day: string;
  label: string;
  row: number;
  model: string | null;
  cost_usd: number;
  fetched_at: number;
}

interface TotalRow {
  month: string;
  total_usd: number;
  fetched_at: number;
}

export interface PortalSyncResult {
  costs: number;
  totals: number;
  status: PostResult | "disabled" | "unchanged" | "empty";
}

const iso = (ms: number) => new Date(ms).toISOString();

const costPayload = (r: CostRow) => ({
  day: r.day,
  label: r.label,
  row: r.row,
  model: r.model,
  costUsd: r.cost_usd,
  fetchedAt: iso(r.fetched_at),
});

const totalPayload = (r: TotalRow) => ({ month: r.month, totalUsd: r.total_usd, fetchedAt: iso(r.fetched_at) });

function saveWatermark(db: Database, fetchedAt: number): void {
  db.prepare(
    `INSERT INTO collector_state (source, cursor, last_run_at, last_status, last_note)
     VALUES (?, ?, datetime('now'), 'ok', 'IU portal rows pushed to Argo')
     ON CONFLICT (source) DO UPDATE SET
       cursor=excluded.cursor, last_run_at=excluded.last_run_at,
       last_status=excluded.last_status, last_note=excluded.last_note`,
  ).run(WATERMARK_KEY, String(fetchedAt));
}

/** Rows to send: everything on the first run, afterwards the resend window plus anything newer than the watermark. */
function pendingCosts(db: Database, watermark: number | null): CostRow[] {
  const select = `SELECT day, label, row, model, cost_usd, fetched_at FROM iu_portal_cost`;
  if (watermark === null) return db.query<CostRow, []>(`${select} ORDER BY day, label, row`).all();
  return db
    .query<CostRow, [number]>(
      `${select}
       WHERE fetched_at > ?1 OR day >= date((SELECT max(day) FROM iu_portal_cost), '-${RESEND_DAYS} days')
       ORDER BY day, label, row`,
    )
    .all(watermark);
}

/**
 * Push the portal tables when a fetch landed since the last successful push.
 * Best-effort like the account tables: an unreachable or pre-deploy Argo leaves the
 * watermark where it was, so the next run retries the same rows.
 */
export async function syncPortal(
  db: Database,
  cfg: ArgoConfig | null = argoConfig(),
  post: typeof postJson = postJson,
): Promise<PortalSyncResult> {
  if (!cfg) return { costs: 0, totals: 0, status: "disabled" };

  const newest = db.query<{ t: number | null }, []>("SELECT max(fetched_at) t FROM iu_portal_cost").get()?.t ?? null;
  if (newest === null) return { costs: 0, totals: 0, status: "empty" };

  const stored = loadCursor(db, WATERMARK_KEY);
  const watermark = stored === null ? null : Number(stored);
  if (watermark !== null && Number.isFinite(watermark) && watermark >= newest) {
    return { costs: 0, totals: 0, status: "unchanged" };
  }

  const costs = pendingCosts(db, Number.isFinite(watermark) ? watermark : null);
  const totals = db
    .query<TotalRow, [number]>("SELECT month, total_usd, fetched_at FROM iu_portal_total ORDER BY month DESC LIMIT ?")
    .all(MAX_TOTALS);

  let sent = 0;
  for (let i = 0; i === 0 || i < costs.length; i += BATCH) {
    const body = { costs: costs.slice(i, i + BATCH).map(costPayload), totals: i === 0 ? totals.map(totalPayload) : [] };
    const result = await post(cfg, PATH, body, { tolerateMissing: true });
    if (result !== "ok") return { costs: sent, totals: 0, status: result };
    sent += body.costs.length;
  }

  saveWatermark(db, newest);
  log.info(`sync: pushed ${costs.length} portal cost rows, ${totals.length} totals`);
  return { costs: costs.length, totals: totals.length, status: "ok" };
}
