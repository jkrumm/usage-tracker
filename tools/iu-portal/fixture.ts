import type { PortalDocument, RawCapture } from './parse.ts'

/** Three days, two rows, plus an all-zero row that must be dropped. Y spacing 13 like the real heatmap. */
export const rawDaily: RawCapture = {
  totalText: '$12.50',
  costCenter: 'CC00000',
  periodLabels: ['2026-10-24', '2026-10-25', '2026-10-26'],
  cells: [
    { x: 147.4, y: 15, value: '0' },
    { x: 163.3, y: 15, value: '0' },
    { x: 179.2, y: 15, value: '0' },
    { x: 147.4, y: 28, value: '1.5' },
    { x: 163.3, y: 28, value: '0' },
    { x: 179.2, y: 28, value: '4' },
    { x: 147.4, y: 41, value: '2' },
    { x: 163.3, y: 41, value: '3' },
    { x: 179.2, y: 41, value: '2' },
  ],
  rowLabels: [
    { y: 19, text: 'Claude Fable 5' },
    { y: 32, text: 'Claude Haiku 5 5 Eu' },
    { y: 45, text: 'Gpt 5.6 Terra' },
  ],
}

/** A 31-day report ending 2026-10-26: $1/day on one model, an extra $10 on the last day on another. */
export function monthDoc(): PortalDocument {
  const periods: string[] = []
  const base = new Date('2026-09-26T00:00:00Z')
  for (let i = 0; i < 31; i++) {
    const d = new Date(base)
    d.setUTCDate(base.getUTCDate() + i)
    periods.push(d.toISOString().slice(0, 10))
  }
  return {
    fetched_at: '2026-10-26T07:00:00.000Z',
    cost_center: 'CC00000',
    total_usd: 41,
    granularity: 'daily',
    periods,
    rows: [
      {
        label: 'Claude Haiku 5 5 Eu',
        row: 1,
        cells: Object.fromEntries(periods.map((p) => [p, 1])),
      },
      { label: 'Gpt 5.6 Terra', row: 2, cells: { '2026-10-26': 10 } },
    ],
  }
}
