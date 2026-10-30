import type { PortalDocument } from './parse.ts'

// The latest.json contract, schema 1, written on both machines from the same daily
// scrape: on iumac by the scrape itself (Tinycast, works with the mini down) and on
// the mini by the collector (agent-gateway's OCR gate). The cap is a rolling 30-day
// window, not a calendar month.

export const LIMIT_USD = 500
export const WINDOW_DAYS = 30

export interface Latest {
  schema: 1
  fetched_at: string
  limit_usd: number
  window_days: number
  /** Sum of the last 30 days, today included. */
  rolling30_usd: number
  /** limit − sum of the 29 days before today: today's total allowance (spend already made today is not deducted). */
  can_spend_today_usd: number
  /** Last 31 days, ascending, zero days included. */
  daily: Array<{ day: string; usd: number }>
  /** Window, top 10 by cost, descending. */
  top_models: Array<{ label: string; usd: number }>
  /** The next 7 days that leave the window, oldest first, and what each frees. */
  dropoff_next7: Array<{ day: string; frees_usd: number }>
}

const round = (n: number) => Math.round(n * 100) / 100

/** `day` shifted by `delta` days, UTC calendar arithmetic. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** Throws unless `doc` is a daily report whose last period is the portal's today. */
export function buildLatest(doc: PortalDocument): Latest {
  if (doc.granularity !== 'daily') throw new Error('latest.json needs the daily report')
  const today = doc.periods.at(-1)
  if (!today) throw new Error('daily report has no periods')

  const perDay = new Map<string, number>()
  const perLabel = new Map<string, number>()
  for (const row of doc.rows) {
    for (const [day, usd] of Object.entries(row.cells)) {
      perDay.set(day, (perDay.get(day) ?? 0) + usd)
    }
  }
  const usdOn = (day: string) => perDay.get(day) ?? 0
  const windowStart = addDays(today, -(WINDOW_DAYS - 1))
  for (const row of doc.rows) {
    for (const [day, usd] of Object.entries(row.cells)) {
      if (day >= windowStart) perLabel.set(row.label, (perLabel.get(row.label) ?? 0) + usd)
    }
  }

  const span = (from: number, to: number) => {
    const days: string[] = []
    for (let i = from; i <= to; i++) days.push(addDays(today, i))
    return days
  }
  const sum = (days: string[]) => days.reduce((s, d) => s + usdOn(d), 0)

  return {
    schema: 1,
    fetched_at: doc.fetched_at,
    limit_usd: LIMIT_USD,
    window_days: WINDOW_DAYS,
    rolling30_usd: round(sum(span(-(WINDOW_DAYS - 1), 0))),
    can_spend_today_usd: round(LIMIT_USD - sum(span(-(WINDOW_DAYS - 1), -1))),
    daily: span(-30, 0).map((day) => ({ day, usd: round(usdOn(day)) })),
    top_models: [...perLabel.entries()]
      .map(([label, usd]) => ({ label, usd: round(usd) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 10),
    dropoff_next7: span(-(WINDOW_DAYS - 1), -(WINDOW_DAYS - 7)).map((day) => ({
      day,
      frees_usd: round(usdOn(day)),
    })),
  }
}
