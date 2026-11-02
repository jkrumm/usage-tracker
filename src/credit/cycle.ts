// Credit cycles. Same rule as the gateway's pools/cycle.ts (agent-workflows), copied on purpose: the two repos agree on
// the rule, not on a package. `cycleDay` is the day the credit expires and renews (Console Billing), 00:00 UTC; a cycle
// runs [start, end) from one expiry to the next, both clamped to short months (31 -> Feb 28/29). The expiry instant
// belongs to the new cycle.

const DAY_MS = 86_400_000

export interface Cycle {
  start: Date
  end: Date
}

/** 00:00 UTC on `day` of `month` (may overflow into a neighbouring year), clamped to that month's last day. */
function anchor(year: number, month: number, day: number): Date {
  const first = new Date(Date.UTC(year, month, 1))
  const y = first.getUTCFullYear()
  const m = first.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)))
}

/** The cycle containing `now`. */
export function cycleOf(cycleDay: number, now: Date): Cycle {
  if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 31) {
    throw new RangeError(`cycleDay must be an integer 1-31, got ${cycleDay}`)
  }
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const thisMonth = anchor(year, month, cycleDay)
  if (now.getTime() >= thisMonth.getTime()) {
    return { start: thisMonth, end: anchor(year, month + 1, cycleDay) }
  }
  return { start: anchor(year, month - 1, cycleDay), end: thisMonth }
}

/** The cycle that ended where `cycle` starts. */
export function previousCycle(cycleDay: number, cycle: Cycle): Cycle {
  return cycleOf(cycleDay, new Date(cycle.start.getTime() - 1))
}

/** 00:00 UTC of the day containing `t`. */
export function utcDay(t: Date): Date {
  return new Date(Math.floor(t.getTime() / DAY_MS) * DAY_MS)
}
