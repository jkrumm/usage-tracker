// Pure assembly of the portal's heatmap DOM into the scrape document. The
// browser side (scrape.ts) only extracts raw numbers; everything that can be
// wrong about them is checked here, where it is testable without a browser.

export type Granularity = "daily" | "monthly";

/** What scrape.ts reads out of the page, untouched. */
export interface RawCapture {
  /** Text of the "Total Cost" card, e.g. "$577.93". */
  totalText: string;
  costCenter: string | null;
  /** Period labels of the "Cost Breakdown by Period" bar chart, in DOM order. */
  periodLabels: string[];
  /** One entry per `g.mud-chart-cell`: rect x/y and the `<title>` text. */
  cells: Array<{ x: number; y: number; value: string }>;
  /** `text.mud-charts-yaxis` row labels with their translate(X, Y). */
  rowLabels: Array<{ y: number; text: string }>;
}

export interface PortalDocument {
  fetched_at: string;
  cost_center: string | null;
  total_usd: number;
  granularity: Granularity;
  /** Normalized: `YYYY-MM-DD` (daily) or `YYYY-MM` (monthly). */
  periods: string[];
  rows: Array<{ label: string; row: number; cells: Record<string, number> }>;
}

const DAILY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHLY = /^(\d{2})(\d{4})$/;

export function parseUsd(text: string): number {
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`unparseable amount "${text}"`);
  return n;
}

/** `2026-10-26` stays, `102026` becomes `2026-10`; anything else is an error. */
export function normalizePeriod(label: string, granularity: Granularity): string {
  const t = label.trim();
  if (granularity === "daily") {
    if (!DAILY.test(t)) throw new Error(`not a daily period: "${t}"`);
    return t;
  }
  const m = MONTHLY.exec(t);
  if (!m) throw new Error(`not a monthly period: "${t}"`);
  return `${m[2]}-${m[1]}`;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Build the document. Throws when the capture is inconsistent: label/column
 * counts that disagree, a row label that cannot be found for a cell, or a cell
 * sum that is off the "Total Cost" card by more than a cent — the guard against
 * scraping a half-rendered or stale chart.
 */
export function assemble(raw: RawCapture, granularity: Granularity, fetchedAt = new Date()): PortalDocument {
  const total = parseUsd(raw.totalText);
  const periods = raw.periodLabels.map((l) => normalizePeriod(l, granularity));

  const xs = [...new Set(raw.cells.map((c) => c.x))].sort((a, b) => a - b);
  if (xs.length !== periods.length) {
    throw new Error(`heatmap has ${xs.length} columns but the bar chart has ${periods.length} periods`);
  }
  const periodOf = new Map(xs.map((x, i) => [x, periods[i]!]));

  // A row's label sits inside its cell band (cell y + 4 with many rows, cell y + ~47 when
  // the chart has few, taller rows), so the label of a cell is the first one at or below its
  // top edge and within one row pitch of it. Two rows can share a label, so rows are indexed by
  // Y, never merged by name.
  const ys = [...new Set(raw.cells.map((c) => c.y))].sort((a, b) => a - b);
  const labels = raw.rowLabels.map((l) => ({ y: l.y, text: l.text.trim() })).sort((a, b) => a.y - b.y);
  const pitch = ys.length > 1 ? ys[1]! - ys[0]! : Infinity;
  const labelOf = (cellY: number): string | undefined =>
    labels.find((l) => l.y >= cellY - 1 && l.y < cellY + pitch)?.text;
  const rows = new Map<number, { label: string; row: number; cells: Record<string, number> }>();
  let sum = 0;
  for (const c of raw.cells) {
    const value = parseUsd(c.value);
    sum += value;
    if (value === 0) continue;
    const label = labelOf(c.y);
    if (label === undefined) throw new Error(`no row label for cell at y=${c.y}`);
    let row = rows.get(c.y);
    if (!row) {
      row = { label, row: ys.indexOf(c.y), cells: {} };
      rows.set(c.y, row);
    }
    row.cells[periodOf.get(c.x)!] = value;
  }
  if (Math.abs(cents(sum) - cents(total)) > 1) {
    throw new Error(`cell sum $${sum.toFixed(2)} does not match Total Cost $${total.toFixed(2)}`);
  }

  return {
    fetched_at: fetchedAt.toISOString(),
    cost_center: raw.costCenter,
    total_usd: total,
    granularity,
    periods,
    rows: [...rows.values()].sort((a, b) => a.row - b.row),
  };
}
