import type { SQL } from "bun";
import { addDays, WINDOW_DAYS } from "../tools/iu-portal/latest.ts";
import { readPortalState } from "./collectors/iu-portal.ts";
import { DEFAULT_IU_KEY, iuKeyDef, type IuKey } from "./iu-keys.ts";

// The IU employee cap is a ROLLING 30-day window (today plus the 29 days before),
// measured by IU's portal (usage.iu_portal_cost). usage.records.cost_usd for billing='api_key' is our own
// estimate and stays: this report compares the two so a wrong rate card, a
// missing collector or an IU-side charge shows up. It never replaces either.
// Tracked spend reads usage.records_unique: the gateway mirror copies of docs/usage-schema.md are not counted twice.
// Days are UTC calendar days on both sides (the portal's calendar is assumed UTC).

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
  iuKey: IuKey;
  limitUsd: number;
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

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface DayKeyUsd {
  day: string;
  key: string;
  usd: number;
}

/** The portal's cells of one key in [from, to], per day and model (our model where the label matched, else the label). */
async function portalCells(sql: SQL, iuKey: IuKey, from: string, to: string): Promise<DayKeyUsd[]> {
  return (await sql`
    SELECT day::text AS day, coalesce(model, label) AS key, sum(cost_usd)::float8 AS usd
    FROM usage.iu_portal_cost
    WHERE iu_key = ${iuKey} AND day BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2`) as DayKeyUsd[];
}

/** Null when no portal report has been stored yet. */
export async function buildBudget(sql: SQL, now = Date.now(), iuKey: IuKey = DEFAULT_IU_KEY): Promise<BudgetReport | null> {
  const limit = iuKeyDef(iuKey)?.limitUsd;
  if (limit === undefined) throw new Error(`unknown IU key "${iuKey}"`);
  const state = await readPortalState(sql, iuKey);
  const [fetched] = await sql`SELECT (extract(epoch FROM max(fetched_at)) * 1000)::float8 AS t FROM usage.iu_portal_cost WHERE iu_key = ${iuKey}`;
  const fetchedAt = (fetched?.t as number | null | undefined) ?? null;
  if (fetchedAt === null) return null;

  const today = state.lastDay ?? utcDay(now);
  const windowStart = addDays(today, -(WINDOW_DAYS - 1));

  const portalRows = await portalCells(sql, iuKey, windowStart, today);
  const trackedRows = (await sql`
    SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(model, '?') AS key, sum(coalesce(cost_usd, 0))::float8 AS usd
    FROM usage.records_unique
    WHERE billing = 'api_key' AND api_key = ${iuKey}
      AND ts >= (${windowStart}::date::timestamp AT TIME ZONE 'UTC') AND ts < ((${today}::date + 1)::timestamp AT TIME ZONE 'UTC')
    GROUP BY 1, 2`) as DayKeyUsd[];

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
    return { day, frees: usd(day), headroomAfter: limit - (rolling30 - freed) };
  });

  const merge = (a: Map<string, number>, b: Map<string, number>): Cmp[] =>
    [...new Set([...a.keys(), ...b.keys()])].map((key) => ({ key, portal: a.get(key) ?? 0, tracked: b.get(key) ?? 0 }));
  const models = merge(portalModel, trackedModel).sort((a, b) => Math.max(b.portal, b.tracked) - Math.max(a.portal, a.tracked));

  const monthly = (await sql`
    SELECT t.month, t.total_usd::float8 AS portal,
           coalesce((SELECT sum(c.cost_usd) FROM usage.iu_portal_cost c
                     WHERE c.iu_key = t.iu_key AND to_char(c.day, 'YYYY-MM') = t.month), 0)::float8 AS "dailySum"
    FROM usage.iu_portal_total t
    WHERE t.iu_key = ${iuKey}
    ORDER BY t.month`) as BudgetReport["monthly"];

  return {
    iuKey,
    limitUsd: limit,
    today,
    windowStart,
    fetchedAt,
    rolling30,
    canSpendToday: limit - sum(span(-(WINDOW_DAYS - 1), -1).map(usd)),
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
  if (!b) return "budget: no IU portal data for this key yet — run `make iu-portal-setup && make iu-portal`";
  const ageH = b.fetchedAt === null ? null : (now - b.fetchedAt) / 3_600_000;
  const over = b.rolling30 > b.limitUsd;
  const lines = [
    `IU cap [${b.iuKey}] — rolling ${WINDOW_DAYS} days ${b.windowStart}..${b.today} (portal fetched ${ageH === null ? "never" : `${ageH.toFixed(1)}h ago`})`,
    `rolling30        ${usdFmt(b.rolling30)} of ${usdFmt(b.limitUsd)}   ${over ? `OVER by ${usdFmt(b.rolling30 - b.limitUsd)}` : `headroom ${usdFmt(b.limitUsd - b.rolling30)}`}`,
    `can spend today  ${usdFmt(b.canSpendToday)}   (cap − the 29 days before today)`,
    `burn ${BURN_DAYS}d          ${usdFmt(b.burn7)}/day   rolling30 in ${BURN_DAYS} days at that burn: ${usdFmt(b.projected7)}`,
    "",
    `drop-off, next ${BURN_DAYS} days (a day leaves the window tomorrow, the day after, …)`,
    `${pad("day", 11)} ${r("frees", 9)} ${r("headroom", 10)}`,
    ...b.dropoff.map((d) => `${pad(d.day, 11)} ${r(usdFmt(d.frees), 9)} ${r(usdFmt(d.headroomAfter), 10)}`),
    ...cmpTable("per day: portal vs tracked (billing=api_key); delta = tracked − portal, flag |delta| > max($1, 20% of portal)", b.days, 11),
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

export interface ExplainDay {
  day: string;
  portal: number;
  tracked: number;
  calls: number;
  /** Tokens we saw: input + output + reasoning + cache read + cache write. */
  tokens: number;
  /** Portal USD per million tracked tokens, the rate IU effectively charged. */
  portalPerM: number | null;
  /** Our USD per million tracked tokens. */
  trackedPerM: number | null;
  /** Tracked USD by source, so a missing or double-counting collector shows up. */
  bySource: Array<{ source: string; usd: number }>;
}

export interface Explain {
  model: string;
  days: ExplainDay[];
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Day-by-day portal vs tracked for one model (a records.model or a portal label), newest first. */
export async function buildExplain(sql: SQL, query: string, now = Date.now(), iuKey: IuKey = DEFAULT_IU_KEY): Promise<Explain | null> {
  const state = await readPortalState(sql, iuKey);
  const today = state.lastDay ?? utcDay(now);
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const want = alnum(query);

  const portal = (await portalCells(sql, iuKey, from, today)).filter((r) => alnum(r.key) === want);
  const tracked = (await sql`
    SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, source, count(*)::int AS n,
           sum(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)::float8 AS tok,
           sum(coalesce(cost_usd, 0))::float8 AS usd
    FROM usage.records_unique
    WHERE billing = 'api_key' AND api_key = ${iuKey}
      AND ts >= (${from}::date::timestamp AT TIME ZONE 'UTC') AND ts < ((${today}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND regexp_replace(lower(coalesce(model, '')), '[^a-z0-9]', '', 'g') = ${want}
    GROUP BY 1, 2`) as Array<{ day: string; source: string; n: number; tok: number; usd: number }>;
  if (portal.length === 0 && tracked.length === 0) return null;

  const days = new Map<string, ExplainDay>();
  const at = (day: string) => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, portal: 0, tracked: 0, calls: 0, tokens: 0, portalPerM: null, trackedPerM: null, bySource: [] }));
    return d;
  };
  for (const p of portal) at(p.day).portal += p.usd;
  for (const t of tracked) {
    const d = at(t.day);
    d.tracked += t.usd;
    d.calls += t.n;
    d.tokens += t.tok;
    d.bySource.push({ source: t.source, usd: t.usd });
  }
  for (const d of days.values()) {
    d.portalPerM = d.tokens > 0 ? (d.portal / d.tokens) * 1e6 : null;
    d.trackedPerM = d.tokens > 0 ? (d.tracked / d.tokens) * 1e6 : null;
  }
  return { model: query, days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)) };
}

export function formatExplain(e: Explain | null, query: string): string {
  if (!e) return `budget --explain: no portal or tracked rows for "${query}" in the window`;
  const lines = [
    `${e.model} — portal vs tracked per day (rate = USD per million tracked tokens)`,
    `${pad("day", 11)} ${r("portal", 9)} ${r("tracked", 9)} ${r("delta", 9)} ${r("calls", 6)} ${r("tokens", 11)} ${r("portal/M", 9)} ${r("ours/M", 9)}  tracked by source`,
  ];
  let portal = 0;
  let tracked = 0;
  for (const d of e.days) {
    portal += d.portal;
    tracked += d.tracked;
    const rate = (n: number | null) => (n === null ? "-" : usdFmt(n));
    lines.push(
      `${pad(d.day, 11)} ${r(usdFmt(d.portal), 9)} ${r(usdFmt(d.tracked), 9)} ${r(usdFmt(d.tracked - d.portal), 9)} ${r(String(d.calls), 6)} ${r(String(d.tokens), 11)} ${r(rate(d.portalPerM), 9)} ${r(rate(d.trackedPerM), 9)}${isOff(d) ? "  <-- off" : ""}  ${d.bySource.map((s) => `${s.source} ${usdFmt(s.usd)}`).join(", ")}`,
    );
  }
  lines.push(`${pad("total", 11)} ${r(usdFmt(portal), 9)} ${r(usdFmt(tracked), 9)} ${r(usdFmt(tracked - portal), 9)}`);
  return lines.join("\n");
}
