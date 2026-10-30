import { describe, expect, test } from 'bun:test'
import { rawDaily } from './fixture.ts'
import { assemble, normalizePeriod } from './parse.ts'

describe('assemble', () => {
  test('maps columns onto periods, rows by label, and drops all-zero rows', () => {
    const doc = assemble(rawDaily, 'daily', new Date('2026-10-26T07:00:00Z'))
    expect(doc.total_usd).toBe(12.5)
    expect(doc.periods).toEqual(['2026-10-24', '2026-10-25', '2026-10-26'])
    expect(doc.rows).toEqual([
      { label: 'Claude Haiku 5 5 Eu', row: 1, cells: { '2026-10-24': 1.5, '2026-10-26': 4 } },
      {
        label: 'Gpt 5.6 Terra',
        row: 2,
        cells: { '2026-10-24': 2, '2026-10-25': 3, '2026-10-26': 2 },
      },
    ])
  })

  test('two rows sharing a label stay two rows', () => {
    const raw = {
      ...rawDaily,
      totalText: '$12.50',
      rowLabels: rawDaily.rowLabels.map((l) =>
        l.y === 45 ? { ...l, text: 'Claude Haiku 5 5 Eu' } : l,
      ),
    }
    const doc = assemble(raw, 'daily')
    expect(doc.rows.map((r) => [r.label, r.row])).toEqual([
      ['Claude Haiku 5 5 Eu', 1],
      ['Claude Haiku 5 5 Eu', 2],
    ])
  })

  test('a report with few, tall rows (label at the middle of the cell band) maps cells to the right label', () => {
    const xs = [363.7, 403.2, 442.7]
    const raw = {
      totalText: '$10.06',
      costCenter: null,
      periodLabels: ['2026-10-26', '2026-10-27', '2026-10-28'],
      cells: [15, 114, 213].flatMap((y, r) =>
        xs.map((x, c) => ({
          x,
          y,
          value: String(
            [
              [4, 3, 2],
              [0, 0.05, 0],
              [0.01, 0, 1],
            ][r]![c],
          ),
        })),
      ),
      rowLabels: [
        { y: 62, text: 'Deepseek V4.1 Flash' },
        { y: 161, text: 'Gemini 3.5 Flash' },
        { y: 260, text: 'Sonar' },
      ],
    }
    expect(assemble(raw, 'daily').rows).toEqual([
      {
        label: 'Deepseek V4.1 Flash',
        row: 0,
        cells: { '2026-10-26': 4, '2026-10-27': 3, '2026-10-28': 2 },
      },
      { label: 'Gemini 3.5 Flash', row: 1, cells: { '2026-10-27': 0.05 } },
      { label: 'Sonar', row: 2, cells: { '2026-10-26': 0.01, '2026-10-28': 1 } },
    ])
  })

  test("a labelless row is an error, never the neighbour's label", () => {
    const raw = {
      totalText: '$4.00',
      costCenter: null,
      periodLabels: ['2026-10-27'],
      cells: [
        { x: 10, y: 15, value: '1' },
        { x: 10, y: 114, value: '3' },
      ],
      rowLabels: [{ y: 62, text: 'Only First' }],
    }
    expect(() => assemble(raw, 'daily')).toThrow(/no row label for cell at y=114/)
  })

  test('rejects a cell sum that is off the Total Cost card (stale or half-rendered chart)', () => {
    expect(() => assemble({ ...rawDaily, totalText: '$99.00' }, 'daily')).toThrow(
      /does not match Total Cost/,
    )
  })

  test('rejects a column/period count mismatch and a granularity mismatch', () => {
    expect(() => assemble({ ...rawDaily, periodLabels: ['2026-10-24'] }, 'daily')).toThrow(
      /3 columns/,
    )
    expect(() => assemble(rawDaily, 'monthly')).toThrow(/not a monthly period/)
  })

  test('a cell without a row label is an error, not a silent drop', () => {
    expect(() => assemble({ ...rawDaily, rowLabels: [] }, 'daily')).toThrow(/no row label/)
  })
})

test('monthly periods become YYYY-MM', () => {
  expect(normalizePeriod('102026', 'monthly')).toBe('2026-10')
  expect(normalizePeriod('072026', 'monthly')).toBe('2026-07')
})
