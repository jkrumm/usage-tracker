import type { Database } from "bun:sqlite";
import { addDays, LIMIT_USD, WINDOW_DAYS } from "../tools/iu-portal/latest.ts";
import { readPortalState } from "./collectors/iu-portal.ts";

// The IU employee cap is a ROLLING 30-day window (today plus the 29 days before),
// measured by IU's portal. usage_record.cost_usd for billing='iu' is our own
// estimate and stays: this report compares the two so a wrong rate card, a
// missing collector or an IU-side charge shows up. It never replaces either.

const BURN_DAYS = 7;
const FLAG_MIN_USD = 1;
const FLAG_RATIO = 0.2;
const TOP_MODELS = 15;

interface Cmp {
  key: string;
  portal: number;
  tracked: number;
}

export interface BudgetReport {
  today: string;
  windowStart: string;
  fetchedAt: number | null;
  rolling30: number;
  canSpendToday: number;
  burn7: number;
  projected7: number;
  dropoff: Array<{ day: string; frees: number; headroomAfter: number }>;
  days: Cmp[];
  models: Cmp[];
  /** Portal spend on models we have no tracked cost for. */
  unseen: Cmp[];
  /** Tracked IU spend on models the portal does not list. */
  unbilled: Cmp[];
  monthly: Array<{ month: string; portal: number; dailySum: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: Iterable<number>) => [...xs].reduce((a, b) => a + b, 0);
export const isOff = (c: { portal: number; tracked: number }) =>
  Math.abs(c.tracked - c.portal) > Math.max(FLAG_MIN_USD, FLAG_RATIO * c.portal);

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Null when no portal report has been stored yet. */
export function buildBudget(db: Database, now = Date.now()): BudgetReport | null {
  const state = readPortalState(db);
  const fetchedAt = db.query<{ t: number | null }, []>("SELECT max(fetched_at) t FROM iu_portal_cost").get()?.t ?? null;
  if (fetchedAt === null) return null;

  const today = state.lastDay ?? localDay(now);
  const windowStart = addDays(today, -(WINDOW_DAYS - 1));

  const portalRows = db
    .query<{ day: string; key: string; usd: number }, [string, string]>(
      `SELECT day, COALESCE(model, label) key, sum(cost_usd) usd FROM iu_portal_cost
       WHERE day BETWEEN ? AND ? GROUP BY day, key`,
    )
    .all(windowStart, today);
  const trackedRows = db
    .query<{ day: string; key: string; usd: number }, [string, string]>(
      `SELECT substr(ts, 1, 10) day, COALESCE(model_norm, model, '?') key, sum(COALESCE(cost_usd, 0)) usd
       FROM usage_record WHERE billing = 'iu' AND substr(ts, 1, 10) BETWEEN ? AND ? GROUP BY day, key`,
    )
    .all(windowStart, today);

  const portalDay = new Map<string, number>();
  const trackedDay = new Map<string, number>();
  const portalModel = new Map<string, number>();
  const trackedModel = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const r of portalRows) {
    add(portalDay, r.day, r.usd);
    add(portalModel, r.key, r.usd);
  }
  for (const r of trackedRows) {
    add(trackedDay, r.day, r.usd);
    add(trackedModel, r.key, r.usd);
  }

  const usd = (day: string) => portalDay.get(day) ?? 0;
  const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => addDays(today, from + i));
  const rolling30 = sum(span(-(WINDOW_DAYS - 1), 0).map(usd));
  const burn7 = sum(span(-(BURN_DAYS - 1), 0).map(usd)) / BURN_DAYS;

  let freed = 0;
  const dropoff = span(-(WINDOW_DAYS - 1), -(WINDOW_DAYS - BURN_DAYS)).map((day) => {
    freed += usd(day);
    return { day, frees: usd(day), headroomAfter: LIMIT_USD - (rolling30 - freed) };
  });

  const merge = (a: Map<string, number>, b: Map<string, number>): Cmp[] =>
    [...new Set([...a.keys(), ...b.keys()])].map((key) => ({ key, portal: a.get(key) ?? 0, tracked: b.get(key) ?? 0 }));
  const models = merge(portalModel, trackedModel).sort((a, b) => Math.max(b.portal, b.tracked) - Math.max(a.portal, a.tracked));

  const monthly = db
    .query<{ month: string; total_usd: number }, []>("SELECT month, total_usd FROM iu_portal_total ORDER BY month")
    .all()
    .map((m) => ({
      month: m.month,
      portal: m.total_usd,
      dailySum:
        db
          .query<{ s: number | null }, [string]>("SELECT sum(cost_usd) s FROM iu_portal_cost WHERE substr(day, 1, 7) = ?")
          .get(m.month)?.s ?? 0,
    }));

  return {
    today,
    windowStart,
    fetchedAt,
    rolling30,
    canSpendToday: LIMIT_USD - sum(span(-(WINDOW_DAYS - 1), -1).map(usd)),
    burn7,
    projected7: rolling30 - sum(dropoff.map((d) => d.frees)) + BURN_DAYS * burn7,
    dropoff,
    days: span(-(WINDOW_DAYS - 1), 0).map((day) => ({ key: day, portal: usd(day), tracked: trackedDay.get(day) ?? 0 })),
    models,
    unseen: models.filter((m) => m.portal > 0 && m.tracked === 0),
    unbilled: models.filter((m) => m.tracked > 0 && m.portal === 0),
    monthly,
  };
}

const usdFmt = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pad = (s: string, w: number) => s.padEnd(w).slice(0, Math.max(w, s.length));
const r = (s: string, w: number) => s.padStart(w);

function cmpTable(title: string, rows: Cmp[], keyWidth: number): string[] {
  const lines = ["", title, `${pad("", keyWidth)} ${r("portal", 10)} ${r("tracked", 10)} ${r("delta", 10)} ${r("ratio", 6)}`];
  for (const c of rows) {
    const ratio = c.portal > 0 ? `${(c.tracked / c.portal).toFixed(2)}x` : "-";
    lines.push(
      `${pad(c.key, keyWidth)} ${r(usdFmt(c.portal), 10)} ${r(usdFmt(c.tracked), 10)} ${r(usdFmt(c.tracked - c.portal), 10)} ${r(ratio, 6)}${isOff(c) ? "  <-- off" : ""}`,
    );
  }
  return lines;
}

export function formatBudget(b: BudgetReport | null, now = Date.now()): string {
  if (!b) return "budget: no IU portal data yet — run `make iu-portal-setup && make iu-portal`";
  const ageH = b.fetchedAt === null ? null : (now - b.fetchedAt) / 3_600_000;
  const over = b.rolling30 > LIMIT_USD;
  const lines = [
    `IU cap — rolling ${WINDOW_DAYS} days ${b.windowStart}..${b.today} (portal fetched ${ageH === null ? "never" : `${ageH.toFixed(1)}h ago`})`,
    `rolling30        ${usdFmt(b.rolling30)} of ${usdFmt(LIMIT_USD)}   ${over ? `OVER by ${usdFmt(b.rolling30 - LIMIT_USD)}` : `headroom ${usdFmt(LIMIT_USD - b.rolling30)}`}`,
    `can spend today  ${usdFmt(b.canSpendToday)}   (cap − the 29 days before today)`,
    `burn ${BURN_DAYS}d          ${usdFmt(b.burn7)}/day   rolling30 in ${BURN_DAYS} days at that burn: ${usdFmt(b.projected7)}`,
    "",
    `drop-off, next ${BURN_DAYS} days (a day leaves the window tomorrow, the day after, …)`,
    `${pad("day", 11)} ${r("frees", 9)} ${r("headroom", 10)}`,
    ...b.dropoff.map((d) => `${pad(d.day, 11)} ${r(usdFmt(d.frees), 9)} ${r(usdFmt(d.headroomAfter), 10)}`),
    ...cmpTable("per day: portal vs tracked (billing=iu); delta = tracked − portal, flag |delta| > max($1, 20% of portal)", b.days, 11),
    ...cmpTable(`per model, window total (top ${TOP_MODELS})`, b.models.slice(0, TOP_MODELS), 36),
  ];
  const list = (title: string, rows: Cmp[], field: "portal" | "tracked") =>
    rows.length === 0 ? [] : ["", title, ...rows.map((c) => `  ${pad(c.key, 36)} ${r(usdFmt(c[field]), 10)}`)];
  lines.push(
    ...list("portal spend we do not track (other tools, missing collector, IU-side calls)", b.unseen, "portal"),
    ...list("tracked spend the portal does not bill (our rate card prices something IU does not charge)", b.unbilled, "tracked"),
  );
  if (b.monthly.length > 0) {
    lines.push("", "monthly reconciliation (portal monthly total vs sum of stored daily cells)");
    for (const m of b.monthly) lines.push(`  ${m.month}  portal ${usdFmt(m.portal)}  daily cells ${usdFmt(round2(m.dailySum))}`);
  }
  return lines.join("\n");
}
