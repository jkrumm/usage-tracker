import { expect, test } from 'bun:test'
import { adminWindows } from './admin-api.ts'
import { cycleOf, previousCycle } from './cycle.ts'

const d = (s: string) => new Date(s)
const span = (c: { start: Date; end: Date }) => [c.start.toISOString(), c.end.toISOString()]

test('cycleDay 21: the expiry instant belongs to the new cycle', () => {
  expect(span(cycleOf(21, d('2026-11-02T10:00:00Z')))).toEqual([
    '2026-10-21T00:00:00.000Z',
    '2026-11-21T00:00:00.000Z',
  ])
  expect(span(cycleOf(21, d('2026-10-21T00:00:00Z')))[0]).toBe('2026-10-21T00:00:00.000Z')
  expect(span(cycleOf(21, d('2026-10-20T23:59:59Z')))).toEqual([
    '2026-09-21T00:00:00.000Z',
    '2026-10-21T00:00:00.000Z',
  ])
})

test('cycleDay 27 across a month and a year end', () => {
  expect(span(cycleOf(27, d('2026-11-02T00:00:00Z')))).toEqual([
    '2026-10-27T00:00:00.000Z',
    '2026-11-27T00:00:00.000Z',
  ])
  expect(span(cycleOf(27, d('2026-12-30T00:00:00Z')))).toEqual([
    '2026-12-27T00:00:00.000Z',
    '2027-01-27T00:00:00.000Z',
  ])
  expect(span(cycleOf(27, d('2027-01-05T00:00:00Z')))).toEqual([
    '2026-12-27T00:00:00.000Z',
    '2027-01-27T00:00:00.000Z',
  ])
})

test('a day past the month end is clamped', () => {
  expect(span(cycleOf(31, d('2027-03-10T00:00:00Z')))).toEqual([
    '2027-02-28T00:00:00.000Z',
    '2027-03-31T00:00:00.000Z',
  ])
  expect(span(cycleOf(31, d('2028-02-29T12:00:00Z')))[0]).toBe('2028-02-29T00:00:00.000Z')
})

test('previousCycle ends where the cycle starts', () => {
  const cur = cycleOf(27, d('2026-11-02T00:00:00Z'))
  expect(span(previousCycle(27, cur))).toEqual([
    '2026-09-27T00:00:00.000Z',
    '2026-10-27T00:00:00.000Z',
  ])
})

test('an out-of-range cycleDay throws', () => {
  expect(() => cycleOf(0, new Date())).toThrow(RangeError)
  expect(() => cycleOf(32, new Date())).toThrow(RangeError)
})

test('adminWindows: earlier of previous cycle start and today - 35 d, split into <= 31 days, through today', () => {
  const now = d('2026-11-02T10:00:00Z')
  const w = adminWindows(d('2026-09-21T00:00:00Z'), now)
  expect(w.map((x) => [x.from.toISOString(), x.to.toISOString()])).toEqual([
    ['2026-09-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z'],
    ['2026-10-22T00:00:00.000Z', '2026-11-03T00:00:00.000Z'],
  ])
  // a recent previous cycle: the 35-day floor wins, still one request
  const short = adminWindows(d('2026-10-20T00:00:00Z'), now)
  expect(short).toHaveLength(2)
  expect(short[0]!.from.toISOString()).toBe('2026-09-28T00:00:00.000Z')
  // --days narrows nothing below the previous cycle
  expect(adminWindows(d('2026-10-27T00:00:00Z'), now, 5)[0]!.from.toISOString()).toBe(
    '2026-10-27T00:00:00.000Z',
  )
})

test('adminWindows never starts before 2026-01-01', () => {
  const w = adminWindows(d('2025-06-01T00:00:00Z'), d('2026-01-10T00:00:00Z'))
  expect(w[0]!.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
})

test('the default window always reaches back to the previous cycle start', () => {
  // from April 2026 on, so the 2026-01-01 floor never applies
  for (let cycleDay = 1; cycleDay <= 31; cycleDay++) {
    for (let t = Date.UTC(2026, 3, 1); t < Date.UTC(2028, 0, 1); t += 3 * 86_400_000 + 7_000_000) {
      const now = new Date(t)
      const prev = previousCycle(cycleDay, cycleOf(cycleDay, now))
      const windows = adminWindows(prev.start, now)
      expect(windows[0]!.from.getTime()).toBeLessThanOrEqual(prev.start.getTime())
      expect(windows.at(-1)!.to.getTime()).toBeGreaterThan(now.getTime())
      // contiguous, each at most 31 days
      for (const [i, w] of windows.entries()) {
        expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(31 * 86_400_000)
        if (i > 0) expect(w.from.getTime()).toBe(windows[i - 1]!.to.getTime())
      }
    }
  }
})
