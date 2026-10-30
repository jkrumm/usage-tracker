import type { SQL } from 'bun'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mapBilling } from '../src/pg/writer.ts'
import { storedBilling, type Chosen, type StoredRow } from '../src/backfill.ts'

// The written proof of scripts/backfill-argo.ts: Argo's table against usage.records per source and UTC month, every
// difference put in a category and quantified, and a per-bucket closure check against an independent SQL aggregate.

export class Measures {
  rows = 0
  input = 0
  output = 0
  cacheRead = 0
  cacheWrite = 0
  cw1h = 0
  reasoning = 0
  cost = 0
  add(r: StoredRow, sign = 1): void {
    this.rows += sign
    this.input += sign * r.inputTokens
    this.output += sign * r.outputTokens
    this.cacheRead += sign * r.cacheReadTokens
    this.cacheWrite += sign * r.cacheWriteTokens
    this.cw1h += sign * Math.min(r.cacheWrite1hTokens, r.cacheWriteTokens)
    this.reasoning += sign * r.reasoningTokens
    this.cost += sign * (r.costUsd ?? 0)
  }
  plus(o: Measures, sign = 1): void {
    this.rows += sign * o.rows
    this.input += sign * o.input
    this.output += sign * o.output
    this.cacheRead += sign * o.cacheRead
    this.cacheWrite += sign * o.cacheWrite
    this.cw1h += sign * o.cw1h
    this.reasoning += sign * o.reasoning
    this.cost += sign * o.cost
  }
}

export interface Item {
  source: string
  sourceId: string
  chosen: Chosen
}

export interface DupGroup {
  source: string
  sourceId: string
  kept: string | null
  keptReason: string
  dropped: Array<{ machine: string | null; costUsd: number | null }>
}

export interface SkippedRow {
  source: string
  sourceId: string
  ts: string
  grain: string
  costUsd: number | null
}

export interface Union {
  items: Item[]
  argoRows: number
  sqliteRows: number
  /** Buckets are `source|YYYY-MM` of the row's own ts. */
  argo: Map<string, Measures>
  dropped: Map<string, Measures>
  sqliteOnly: Map<string, Measures>
  skipped: Map<string, Measures>
  skippedList: SkippedRow[]
  dupGroups: DupGroup[]
  dumpedAt: string
  malformedRaw: number
  notes: Map<string, number>
}

export interface SourceCounts {
  items: number
  inserted: number
  skippedExisting: number
}

export interface RunLog {
  at: string
  dryRun: boolean
  seconds: number
  union: number
  changed: number | null
  inserted: number
  skippedExisting: number
}

interface Ctx {
  sql: SQL
  union: Union
  counts: Map<string, SourceCounts>
  runNow: Date
  changed: number | null
  seconds: number
  runs: RunLog[]
  outFile: string
}

type Cat = 'reported' | 'ignored' | 'repriced' | 'repriced1h' | 'lost' | 'gained' | 'never'

class Acc {
  fin = new Measures() // what usage.records holds for these keys
  old = new Measures() // what the chosen legacy row held
  swap = new Measures() // sqlite row minus the Argo row it replaced (both-store keys)
  outside = new Measures() // rows the live pipeline added since the snapshot: in the database, not in the backfilled set
  cat = new Map<Cat, { rows: number; delta: number }>()
  tokenDiffs = 0
  bump(c: Cat, delta: number): void {
    const v = this.cat.get(c) ?? { rows: 0, delta: 0 }
    v.rows++
    v.delta += delta
    this.cat.set(c, v)
  }
  reprice(): number {
    let s = 0
    for (const v of this.cat.values()) s += v.delta
    return s
  }
}

const usd = (x: number): string => x.toFixed(2)
const signed = (x: number, d = 2): string => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(d)}`
const int = (x: number): string => Math.round(x).toLocaleString('en-US')

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '-').join('|')}|`]
  for (const r of rows) out.push(`| ${r.join(' | ')} |`)
  return out.join('\n')
}

const monthRange = (m: string): [string, string] => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  return [`${m}-01T00:00:00Z`, `${next}-01T00:00:00Z`]
}

const monthOfTs = (ts: string): string => {
  const t = Date.parse(ts)
  return Number.isNaN(t) ? 'invalid' : new Date(t).toISOString().slice(0, 7)
}

export async function buildProof(ctx: Ctx): Promise<void> {
  const { sql, union: u } = ctx
  const accs = new Map<string, Acc>()
  const acc = (k: string): Acc => {
    let a = accs.get(k)
    if (!a) accs.set(k, (a = new Acc()))
    return a
  }
  const byModel = new Map<
    string,
    {
      rows: number
      old: number
      new: number
      billing: string
      model: string
      fam: number
      famDelta: number
    }
  >()
  const unpriced = new Map<
    string,
    {
      rows: number
      marker: number
      tokens: number
      lost: number
      billing: string
      model: string
      sources: Set<string>
    }
  >()
  const billingMismatch: string[] = []
  const reportedMismatch: string[] = []
  const tokenMismatch: string[] = []
  const missing: string[] = []
  const modelChange = new Map<string, number>()
  const markers = new Map<string, { rows: number; cost: number; nullCost: number }>()
  const argoOnlyCw = { rows: 0, cwTokens: 0, cost: 0 }
  let matched = 0
  let accountDropped = 0
  let reportedZero = 0

  // Group the items by source and month, then compare each group with what the database holds.
  const groups = new Map<string, Item[]>()
  for (const it of u.items) {
    const k = `${it.source}|${monthOfTs(it.chosen.row.ts)}`
    let l = groups.get(k)
    if (!l) groups.set(k, (l = []))
    l.push(it)
  }

  for (const [k, items] of [...groups].sort()) {
    const [source, month] = k.split('|') as [string, string]
    const [from, to] = monthRange(month)
    const rows = await sql`
      SELECT source_id, model, billing, account, api_key,
             input_tokens::float8 AS i, output_tokens::float8 AS o, cache_read_tokens::float8 AS cr,
             cache_write_5m_tokens::float8 AS w5, cache_write_1h_tokens::float8 AS w1, reasoning_tokens::float8 AS rs,
             coalesce((raw->>'reasoningTokensUnbilled')::float8, 0) AS unb,
             cost_usd::float8 AS cost, cost_source, cost_reported_usd::float8 AS rep
      FROM usage.records WHERE source = ${source} AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz`
    const pg = new Map<string, Record<string, any>>()
    for (const r of rows) pg.set(r.source_id, r)
    const a = acc(k)
    const claimed = new Set<string>()

    for (const it of items) {
      const o = it.chosen.row
      const p = pg.get(it.sourceId)
      if (!p) {
        if (missing.length < 50) missing.push(`${source}/${it.sourceId}`)
        continue
      }
      matched++
      claimed.add(it.sourceId)
      a.old.add(o)
      const fin = new Measures()
      fin.rows = 1
      fin.input = p.i
      fin.output = p.o
      fin.cacheRead = p.cr
      fin.cacheWrite = p.w5 + p.w1
      fin.cw1h = p.w1
      fin.reasoning = p.rs + p.unb
      fin.cost = p.cost ?? 0
      a.fin.plus(fin)
      if (it.chosen.origin === 'sqlite' && it.chosen.argo) {
        a.swap.add(o)
        a.swap.add(it.chosen.argo, -1)
      }

      const oldTokens = [
        o.inputTokens,
        o.outputTokens,
        o.cacheReadTokens,
        o.cacheWriteTokens,
        o.reasoningTokens,
      ]
      const newTokens = [fin.input, fin.output, fin.cacheRead, fin.cacheWrite, fin.reasoning]
      if (oldTokens.some((t, i) => t !== newTokens[i])) {
        a.tokenDiffs++
        if (tokenMismatch.length < 30)
          tokenMismatch.push(
            `${source}/${it.sourceId}: ${oldTokens.join(',')} -> ${newTokens.join(',')}`,
          )
      }

      const expectBilling = mapBilling(storedBilling(o.billing))
      const expectAccount = expectBilling === 'max' ? o.account : null
      const expectKey = storedBilling(o.billing) === 'iu' ? o.iuKey : null
      if (o.account && expectBilling !== 'max') accountDropped++
      if (
        p.billing !== expectBilling ||
        (p.account ?? null) !== expectAccount ||
        (p.api_key ?? null) !== expectKey
      ) {
        if (billingMismatch.length < 30)
          billingMismatch.push(
            `${source}/${it.sourceId}: ${o.billing}/${o.account}/${o.iuKey} -> ${p.billing}/${p.account}/${p.api_key}`,
          )
      }

      const allZero = oldTokens.every((t) => t === 0)
      if (allZero) {
        const m = markers.get(source) ?? { rows: 0, cost: 0, nullCost: 0 }
        m.rows++
        m.cost += o.costUsd ?? 0
        if (p.cost === null) m.nullCost++
        markers.set(source, m)
      }
      if (it.chosen.origin === 'argo' && o.cacheWriteTokens > 0) {
        argoOnlyCw.rows++
        argoOnlyCw.cwTokens += o.cacheWriteTokens
        argoOnlyCw.cost += o.costUsd ?? 0
      }
      if (o.modelNorm !== p.model) {
        const key = `${o.modelNorm ?? '(null)'} -> ${p.model ?? '(null)'}`
        modelChange.set(key, (modelChange.get(key) ?? 0) + 1)
      }

      const oldCost = o.costUsd ?? 0
      const newCost = p.cost ?? 0
      const delta = newCost - oldCost
      const wasReported = o.costSource === 'reported' && o.costUsd !== null
      let cat: Cat
      if (wasReported) {
        cat = p.cost_source === 'reported' ? 'reported' : 'ignored'
        if (cat === 'reported') {
          if (o.costUsd === 0) reportedZero++
          if (Math.abs(delta) > 1e-9 && reportedMismatch.length < 30)
            reportedMismatch.push(`${source}/${it.sourceId}: ${o.costUsd} -> ${p.cost}`)
        }
      } else if (p.cost === null) cat = o.costUsd === null ? 'never' : 'lost'
      else if (o.costUsd === null) cat = 'gained'
      else cat = p.w1 > 0 ? 'repriced1h' : 'repriced'
      a.bump(cat, delta)

      const mk = `${p.model ?? '(null)'}|${p.billing}`
      if (cat === 'repriced' || cat === 'repriced1h') {
        const m = byModel.get(mk) ?? {
          rows: 0,
          old: 0,
          new: 0,
          billing: p.billing,
          model: p.model ?? '(null)',
          fam: 0,
          famDelta: 0,
        }
        m.rows++
        m.old += oldCost
        m.new += newCost
        if (o.costSource === 'family') {
          m.fam++
          m.famDelta += delta
        }
        byModel.set(mk, m)
      } else if (cat === 'lost' || cat === 'never' || cat === 'gained') {
        const m = unpriced.get(`${cat}|${mk}`) ?? {
          rows: 0,
          marker: 0,
          tokens: 0,
          lost: 0,
          billing: p.billing,
          model: p.model ?? '(null)',
          sources: new Set<string>(),
        }
        m.rows++
        if (allZero) m.marker++
        m.tokens += newTokens[0]! + newTokens[1]! + newTokens[2]! + newTokens[3]!
        m.lost += oldCost
        m.sources.add(source)
        unpriced.set(`${cat}|${mk}`, m)
      }
    }
    for (const [id, p] of pg) {
      if (claimed.has(id)) continue
      const m = new Measures()
      m.rows = 1
      m.input = p.i
      m.output = p.o
      m.cacheRead = p.cr
      m.cacheWrite = p.w5 + p.w1
      m.cw1h = p.w1
      m.reasoning = p.rs + p.unb
      m.cost = p.cost ?? 0
      a.outside.plus(m)
    }
  }

  // Independent aggregate straight from SQL: the number the closure is checked against.
  const sums = await sql`
    SELECT source, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*)::int AS rows,
           sum(input_tokens)::float8 AS i, sum(output_tokens)::float8 AS o, sum(cache_read_tokens)::float8 AS cr,
           sum(cache_write_5m_tokens)::float8 AS w5, sum(cache_write_1h_tokens)::float8 AS w1,
           sum(reasoning_tokens + coalesce((raw->>'reasoningTokensUnbilled')::bigint, 0))::float8 AS rs,
           coalesce(sum(cost_usd), 0)::float8 AS cost
    FROM usage.records GROUP BY 1, 2`
  const sqlSum = new Map<string, Record<string, any>>()
  for (const r of sums) sqlSum.set(`${r.source}|${r.month}`, r)

  const oneH = await sql`
    SELECT r.source, count(*)::int AS n, sum(r.cache_write_1h_tokens)::float8 AS t1h, sum(r.cost_usd)::float8 AS new,
           sum(c.cost_usd)::float8 AS cf
    FROM usage.records r
    CROSS JOIN LATERAL usage.compute_cost(r.model, r.ts, r.input_tokens, r.output_tokens, r.cache_read_tokens,
      r.cache_write_5m_tokens + r.cache_write_1h_tokens, 0, r.reasoning_tokens, r.grain, r.cost_reported_usd) c
    WHERE r.cache_write_1h_tokens > 0 AND r.cost_source IN ('prices', 'override') GROUP BY 1 ORDER BY 1`

  const lanes =
    await sql`SELECT source, lane, count(*)::int AS n FROM usage.records GROUP BY 1, 2 ORDER BY 1, 3 DESC`
  const sessionRows = await sql`
    SELECT s.source, s.lane, count(*)::int AS n FROM usage.sessions s GROUP BY 1, 2 ORDER BY 1, 3 DESC`
  const [sessionTotal] =
    await sql`SELECT count(*)::int AS n, (SELECT count(*)::int FROM usage.records WHERE session_id IS NOT NULL) AS linked FROM usage.sessions`
  const [spanBad] = await sql`
    SELECT count(*)::int AS n FROM usage.sessions s
    JOIN (SELECT session_id, min(ts) AS a, max(ts) AS b FROM usage.records GROUP BY 1) r ON r.session_id = s.id
    WHERE s.first_ts <> r.a OR s.last_ts <> r.b`
  const sessionSample = async (label: string, id: number | null): Promise<string> => {
    if (id === null) return `- ${label}: none`
    const [s] = await sql`
      SELECT s.source, s.source_session_id, s.lane, s.account, s.billing, s.api_key, s.first_ts, s.last_ts,
             (SELECT count(*)::int FROM usage.records r WHERE r.session_id = s.id) AS n
      FROM usage.sessions s WHERE s.id = ${id}`
    return `- ${label}: \`${s.source}\` \`${s.source_session_id}\`, lane \`${s.lane}\`, billing \`${s.billing}\`, account ${s.account ?? 'none'}, key ${s.api_key ?? 'none'}, ${s.n} records, ${new Date(s.first_ts).toISOString()} to ${new Date(s.last_ts).toISOString()}`
  }
  const [big] =
    await sql`SELECT session_id::float8 AS id FROM usage.records WHERE source = 'claude-code' AND session_id IS NOT NULL GROUP BY session_id ORDER BY count(*) DESC, session_id LIMIT 1`
  const [hermes] =
    await sql`SELECT min(id)::float8 AS id FROM usage.sessions WHERE source = 'hermes'`
  const [agw] =
    await sql`SELECT min(id)::float8 AS id FROM usage.sessions WHERE source = 'agent-workflows' AND last_ts > first_ts`
  const sampleLines = [
    await sessionSample('largest Claude Code session', big?.id ?? null),
    await sessionSample('a Hermes session', hermes?.id ?? null),
    await sessionSample('an agent-workflows run', agw?.id ?? null),
  ]

  // ---- assemble ----
  const keys = [...new Set([...u.argo.keys(), ...accs.keys(), ...sqlSum.keys()])].sort()
  const zero = new Measures()
  interface Line {
    k: string
    argo: Measures
    dup: Measures
    sqlOnly: Measures
    skipped: Measures
    a: Acc
    actual: Record<string, any> | undefined
    expectedCost: number
    diffCents: number
    tokenDelta: number[]
  }
  const lines: Line[] = keys.map((k) => {
    const argo = u.argo.get(k) ?? zero
    const dup = u.dropped.get(k) ?? zero
    const sqlOnly = u.sqliteOnly.get(k) ?? zero
    const skipped = u.skipped.get(k) ?? zero
    const a = accs.get(k) ?? new Acc()
    const actual = sqlSum.get(k)
    // Argo - duplicates - skipped + sqlite-only + store swap + repricing
    const expectedCost =
      argo.cost -
      dup.cost -
      skipped.cost +
      sqlOnly.cost +
      a.swap.cost +
      a.reprice() +
      a.outside.cost
    const exp = (f: (m: Measures) => number): number =>
      f(argo) - f(dup) - f(skipped) + f(sqlOnly) + f(a.swap) + f(a.outside)
    const act = actual ?? { rows: 0, i: 0, o: 0, cr: 0, w5: 0, w1: 0, rs: 0, cost: 0 }
    return {
      k,
      argo,
      dup,
      sqlOnly,
      skipped,
      a,
      actual,
      expectedCost,
      diffCents: Math.round((act.cost - expectedCost) * 100),
      tokenDelta: [
        act.rows - exp((m) => m.rows),
        act.i - exp((m) => m.input),
        act.o - exp((m) => m.output),
        act.cr - exp((m) => m.cacheRead),
        act.w5 + act.w1 - exp((m) => m.cacheWrite),
        act.rs - exp((m) => m.reasoning),
      ],
    }
  })

  const total = (f: (l: Line) => number): number => lines.reduce((s, l) => s + f(l), 0)
  const bad = lines.filter((l) => l.diffCents !== 0 || l.tokenDelta.some((d) => d !== 0))
  const sourceList = [...new Set(lines.map((l) => l.k.split('|')[0]!))].sort()
  const sumBy = (source: string, f: (l: Line) => number): number =>
    lines.filter((l) => l.k.startsWith(`${source}|`)).reduce((s, l) => s + f(l), 0)

  const out: string[] = []
  out.push('# Backfill proof: `argo.usage_record` + SQLite archive to `usage.records`')
  out.push('')
  out.push(
    `Argo snapshot taken ${u.dumpedAt} (one repeatable-read transaction, read-only over ssh), SQLite archive read-only (${int(u.sqliteRows)} rows), ` +
      `written by \`scripts/backfill-argo.ts\` into schema \`usage\` of database \`shared\`. Every number below comes from that run; ` +
      `the script is idempotent and re-runnable (\`make backfill-argo\`).`,
  )
  out.push('')
  out.push('## Result')
  out.push('')
  const argoTot = total((l) => l.argo.cost)
  const finalCost = total((l) => l.actual?.cost ?? 0)
  const finalRows = total((l) => l.actual?.rows ?? 0)
  out.push(
    table(
      ['', 'rows', 'cost USD'],
      [
        ['Argo table (snapshot)', int(u.argoRows), usd(argoTot)],
        [
          'SQLite archive',
          int(u.sqliteRows),
          usd(
            [...u.items].reduce(
              (s, it) => s + (it.chosen.origin === 'sqlite' ? (it.chosen.row.costUsd ?? 0) : 0),
              0,
            ),
          ),
        ],
        ['`usage.records` after the backfill', int(finalRows), usd(finalCost)],
      ],
    ),
  )
  out.push('')
  out.push(
    `Buckets that do not close: **${bad.length}** of ${lines.length} (a bucket closes when rows and all five token kinds match exactly and the cost matches to the cent). ` +
      `Records in the database for keys outside the backfilled set (added by the live pipeline since the snapshot, counted in the closure): ${int(total((l) => l.a.outside.rows))}. ` +
      `Records missing after the write: ${missing.length}. Token differences on matched keys: ${tokenMismatch.length === 0 ? 'none' : tokenMismatch.length + '+'}.`,
  )
  out.push('')
  out.push('## Where the difference comes from')
  out.push('')
  out.push(
    'Argo total, minus what the new key collapses, plus what only SQLite holds, plus the store swap and the repricing, is the backfilled total:',
  )
  out.push('')
  const catTot = (c: Cat): { rows: number; delta: number } => {
    let rows = 0
    let delta = 0
    for (const a of accs.values()) {
      const v = a.cat.get(c)
      if (v) {
        rows += v.rows
        delta += v.delta
      }
    }
    return { rows, delta }
  }
  const dupRows = total((l) => l.dup.rows)
  const catRows: Array<Array<string | number>> = [
    ['Argo table', int(u.argoRows), usd(argoTot)],
    [
      '(i) duplicates collapsed by the key `(source, source_id)`',
      `-${int(dupRows)}`,
      signed(-total((l) => l.dup.cost)),
    ],
    [
      'rows not backfilled (unparseable ts or unknown grain)',
      `-${int(u.skippedList.length)}`,
      signed(-total((l) => l.skipped.cost)),
    ],
    [
      'rows added to the database by the live pipeline since the snapshot (outside the set)',
      `+${int(total((l) => l.a.outside.rows))}`,
      signed(total((l) => l.a.outside.cost)),
    ],
    [
      '(ii) rows only SQLite holds',
      `+${int(total((l) => l.sqlOnly.rows))}`,
      signed(total((l) => l.sqlOnly.cost)),
    ],
    [
      "store swap: SQLite's exact cost instead of Argo's float4",
      '0',
      signed(
        total((l) => l.a.swap.cost),
        6,
      ),
    ],
    [
      '(iii) rate tables re-derive the cost (priced both ways, no 1h cache write)',
      int(catTot('repriced').rows),
      signed(catTot('repriced').delta),
    ],
    [
      '(iv) the same, rows with 1h cache writes',
      int(catTot('repriced1h').rows),
      signed(catTot('repriced1h').delta),
    ],
    [
      '(v) lost a price (old cost, now NULL)',
      int(catTot('lost').rows),
      signed(catTot('lost').delta),
    ],
    ['(v) newly priced (old NULL)', int(catTot('gained').rows), signed(catTot('gained').delta)],
    ['(v) unpriced before and after', int(catTot('never').rows), signed(catTot('never').delta)],
    [
      'provider-reported cost kept verbatim',
      int(catTot('reported').rows),
      signed(catTot('reported').delta, 6),
    ],
    [
      'reported cost ignored (`IGNORE_REPORTED_COST`)',
      int(catTot('ignored').rows),
      signed(catTot('ignored').delta),
    ],
    ['**`usage.records`**', int(finalRows), usd(finalCost)],
  ]
  out.push(table(['step', 'rows', 'USD'], catRows))
  out.push('')
  out.push(
    `Closure check: Argo ${usd(argoTot)} ${signed(finalCost - argoTot)} = ${usd(finalCost)} (explained sum ${usd(total((l) => l.expectedCost))}).`,
  )
  out.push('')

  out.push('## Per source')
  out.push('')
  out.push(
    table(
      [
        'source',
        'Argo rows',
        'dup rows',
        'SQLite-only',
        'live-added rows',
        'database rows',
        'Argo $',
        'dup $',
        'SQLite-only $',
        'swap $',
        'repricing $',
        'live-added $',
        'database $',
        'diff (cents)',
      ],
      sourceList.map((s) => [
        s,
        int(sumBy(s, (l) => l.argo.rows)),
        int(sumBy(s, (l) => l.dup.rows)),
        int(sumBy(s, (l) => l.sqlOnly.rows)),
        int(sumBy(s, (l) => l.a.outside.rows)),
        int(sumBy(s, (l) => l.actual?.rows ?? 0)),
        usd(sumBy(s, (l) => l.argo.cost)),
        usd(sumBy(s, (l) => l.dup.cost)),
        usd(sumBy(s, (l) => l.sqlOnly.cost)),
        signed(
          sumBy(s, (l) => l.a.swap.cost),
          6,
        ),
        signed(sumBy(s, (l) => l.a.reprice())),
        usd(sumBy(s, (l) => l.a.outside.cost)),
        usd(sumBy(s, (l) => l.actual?.cost ?? 0)),
        sumBy(s, (l) => l.diffCents),
      ]),
    ),
  )
  out.push('')
  out.push('## Per source and month (UTC)')
  out.push('')
  out.push(
    table(
      [
        'source',
        'month',
        'Argo rows',
        'dup',
        'SQLite-only',
        'live-added',
        'database rows',
        'Argo $',
        'dup $',
        'SQLite-only $',
        'repricing $',
        'live-added $',
        'database $',
        'diff (cents)',
      ],
      lines.map((l) => {
        const [s, m] = l.k.split('|')
        return [
          s!,
          m!,
          int(l.argo.rows),
          int(l.dup.rows),
          int(l.sqlOnly.rows),
          int(l.a.outside.rows),
          int(l.actual?.rows ?? 0),
          usd(l.argo.cost),
          usd(l.dup.cost),
          usd(l.sqlOnly.cost),
          signed(l.a.reprice()),
          usd(l.a.outside.cost),
          usd(l.actual?.cost ?? 0),
          l.diffCents,
        ]
      }),
    ),
  )
  out.push('')
  out.push('## Tokens per source and month')
  out.push('')
  out.push(
    'Backfilled token kinds from `usage.records`. The last column is the difference to Argo after dedup (plus SQLite-only rows, minus skipped rows, plus the store swap) as `rows/input/output/cache_read/cache_write/reasoning`; `0` means every kind matches exactly. ' +
      'Argo stores one cache-write total, so `cache_write_5m + cache_write_1h` is compared with it; the 1h part comes from SQLite. Reasoning counts the unbilled terra tokens kept in `raw.reasoningTokensUnbilled`.',
  )
  out.push('')
  out.push(
    table(
      [
        'source',
        'month',
        'input',
        'output',
        'cache_read',
        'cache_write_5m',
        'cache_write_1h',
        'reasoning',
        'diff vs Argo',
      ],
      lines.map((l) => {
        const [s, m] = l.k.split('|')
        const a = l.actual
        return [
          s!,
          m!,
          int(a?.i ?? 0),
          int(a?.o ?? 0),
          int(a?.cr ?? 0),
          int(a?.w5 ?? 0),
          int(a?.w1 ?? 0),
          int(a?.rs ?? 0),
          l.tokenDelta.every((d) => d === 0) ? '0' : l.tokenDelta.join('/'),
        ]
      }),
    ),
  )
  out.push('')

  // (i)
  out.push('## (i) Duplicates collapsed by the new key')
  out.push('')
  out.push(
    `Argo's key is \`(source, source_id, machine)\`; the new one is \`(source, source_id)\`. In this snapshot ${int(dupRows)} Argo row(s) share a key with another: ` +
      `${int(total((l) => l.dup.input + l.dup.output + l.dup.cacheRead + l.dup.cacheWrite))} tokens, $${usd(total((l) => l.dup.cost))}. ` +
      'The ~$3,081 quoted for the old key does not reproduce on this table; no duplicate of that size exists in `argo.usage_record` or between it and SQLite.',
  )
  out.push('')
  if (u.dupGroups.length > 0) {
    out.push(
      table(
        ['source', 'source_id', 'kept (machine)', 'kept from', 'dropped rows (machine: cost)'],
        u.dupGroups
          .slice(0, 50)
          .map((g) => [
            g.source,
            `\`${g.sourceId}\``,
            g.kept ?? 'none',
            g.keptReason,
            g.dropped.map((d) => `${d.machine ?? 'none'}: ${d.costUsd ?? 'NULL'}`).join(', '),
          ]),
      ),
    )
    out.push('')
  }

  // (ii)
  const sqlOnlyRows = total((l) => l.sqlOnly.rows)
  out.push('## (ii) Rows present in one store only')
  out.push('')
  const argoOnlyBySource = new Map<string, { rows: number; cost: number }>()
  for (const it of u.items) {
    if (it.chosen.origin !== 'argo') continue
    const v = argoOnlyBySource.get(it.source) ?? { rows: 0, cost: 0 }
    v.rows++
    v.cost += it.chosen.row.costUsd ?? 0
    argoOnlyBySource.set(it.source, v)
  }
  out.push(
    `- In SQLite, not in Argo: **${int(sqlOnlyRows)}** rows, $${usd(total((l) => l.sqlOnly.cost))} (rows ingested after the last sync).`,
  )
  const aoRows = [...argoOnlyBySource.values()].reduce((s, v) => s + v.rows, 0)
  const aoCost = [...argoOnlyBySource.values()].reduce((s, v) => s + v.cost, 0)
  out.push(
    `- In Argo, not in SQLite: **${int(aoRows)}** rows, $${usd(aoCost)}, written from the Argo row (posted by agent-workflows, the VPS gateways, email-gateway, Argo itself, or a gateway whose collector was retired):`,
  )
  out.push('')
  out.push(
    table(
      ['source', 'rows', 'Argo $'],
      [...argoOnlyBySource].sort().map(([s, v]) => [s, int(v.rows), usd(v.cost)]),
    ),
  )
  out.push('')
  const swapRows = u.items.filter((it) => it.chosen.origin === 'sqlite' && it.chosen.argo).length
  out.push(
    `- In both stores: ${int(swapRows)} keys, written from SQLite. Token difference between the two rows: ` +
      `${int(total((l) => Math.abs(l.a.swap.input) + Math.abs(l.a.swap.output) + Math.abs(l.a.swap.cacheRead) + Math.abs(l.a.swap.cacheWrite)))} (absolute sum over buckets). ` +
      `Cost difference (SQLite exact minus Argo float4): $${total((l) => l.a.swap.cost).toFixed(6)}.`,
  )
  out.push('')

  // (iii) by model
  out.push('## (iii) Cost re-derived by the rate tables, by model')
  out.push('')
  out.push(
    'Rows priced both before and after (not provider-reported). `old` is the stored `cost_usd` (`pricing.ts` with `FAMILY_PRICING` and the IU rate card), `new` is `usage.compute_cost`. ' +
      'Sorted by absolute delta; this is the table to build IU `price_overrides` from for the `api_key` rows (the portal stays the truth there).',
  )
  out.push('')
  const modelRows = [...byModel.values()].sort(
    (x, y) => Math.abs(y.new - y.old) - Math.abs(x.new - x.old),
  )
  const shown = modelRows.filter((m) => Math.abs(m.new - m.old) >= 0.005)
  out.push(
    table(
      [
        'model',
        'billing',
        'rows',
        'old $',
        'new $',
        'delta $',
        'delta %',
        'of which old family-fallback rows',
        'their delta $',
      ],
      shown.map((m) => [
        m.model,
        m.billing,
        int(m.rows),
        usd(m.old),
        usd(m.new),
        signed(m.new - m.old),
        m.old === 0 ? 'n/a' : `${signed(((m.new - m.old) / m.old) * 100, 1)}%`,
        int(m.fam),
        signed(m.famDelta),
      ]),
    ),
  )
  out.push('')
  const rest = modelRows.filter((m) => Math.abs(m.new - m.old) < 0.005)
  out.push(
    `${int(rest.length)} further model/billing groups differ by less than $0.005 each (${int(rest.reduce((s, m) => s + m.rows, 0))} rows, ${signed(
      rest.reduce((s, m) => s + m.new - m.old, 0),
      4,
    )} in total).`,
  )
  out.push('')
  out.push(
    `Provider-reported rows: ${int(catTot('reported').rows)} rows kept their stored cost as \`cost_reported_usd\`; mismatches: ${reportedMismatch.length === 0 ? 'none (identical)' : reportedMismatch.join('; ')}. ${int(reportedZero)} of them reported $0 and stay reported $0.`,
  )
  out.push('')

  // (iv)
  out.push('## (iv) The 1h cache-write repricing effect')
  out.push('')
  out.push(
    "Argo has no `cache_write_1h_tokens`; every row that exists in SQLite keeps its exact split and is priced with the catalog's 1h rate. " +
      '`new without split` is the same rows priced with all cache writes at the 5m rate (what the Argo data alone would give).',
  )
  out.push('')
  out.push(
    table(
      [
        'source',
        'rows with 1h writes',
        '1h tokens',
        'new $',
        'new without split $',
        'split is worth $',
      ],
      oneH.map((r: Record<string, any>) => [
        r.source,
        int(r.n),
        int(r.t1h),
        usd(r.new),
        usd(r.cf),
        signed(r.new - r.cf),
      ]),
    ),
  )
  out.push('')
  out.push(
    `Repricing delta on rows with 1h writes: ${int(catTot('repriced1h').rows)} rows, ${signed(catTot('repriced1h').delta)} (the old figure priced 1h at its own rate as well, so this is the rate-table difference, not the split). ` +
      `Rows that exist only in Argo and carry cache writes (no split available, all priced at the 5m rate): ${int(argoOnlyCw.rows)} rows, ${int(argoOnlyCw.cwTokens)} tokens, $${usd(argoOnlyCw.cost)} old cost.`,
  )
  out.push('')

  // (v)
  out.push('## (v) Rows without a price (cost NULL)')
  out.push('')
  const un = [...unpriced.entries()]
    .map(([k, v]) => ({ cat: k.split('|')[0]!, ...v }))
    .sort((x, y) => y.lost - x.lost || y.rows - x.rows)
  const unLost = un.filter((x) => x.cat === 'lost')
  const unNever = un.filter((x) => x.cat === 'never')
  const unGained = un.filter((x) => x.cat === 'gained')
  const unTable = (list: typeof un): string =>
    table(
      ['model', 'billing', 'rows', 'of which zero-token', 'tokens', 'old cost lost $', 'sources'],
      list.map((x) => [
        x.model,
        x.billing,
        int(x.rows),
        int(x.marker),
        int(x.tokens),
        usd(x.lost),
        [...x.sources].sort().join(', '),
      ]),
    )
  out.push(
    `### Had a stored cost, now NULL (${int(unLost.reduce((s, x) => s + x.rows, 0))} rows, $${usd(unLost.reduce((s, x) => s + x.lost, 0))})`,
  )
  out.push('')
  out.push(unLost.length ? unTable(unLost) : 'none')
  out.push('')
  out.push(`### NULL before and after (${int(unNever.reduce((s, x) => s + x.rows, 0))} rows)`)
  out.push('')
  out.push(unNever.length ? unTable(unNever) : 'none')
  out.push('')
  out.push(
    `### NULL before, priced now (${int(unGained.reduce((s, x) => s + x.rows, 0))} rows, $${usd(unGained.reduce((s, x) => s + x.lost, 0))} old)`,
  )
  out.push('')
  out.push(unGained.length ? unTable(unGained) : 'none')
  out.push('')
  out.push(
    `Reported cost ignored: ${int(catTot('ignored').rows)} rows ${signed(catTot('ignored').delta)} (\`sonar\`: tokens price it, the vendor figure includes search fees).`,
  )
  out.push('')

  // (vi)
  out.push('## (vi) Everything else')
  out.push('')
  const note = (k: string): number => u.notes.get(k) ?? 0
  const noteLines: string[] = []
  for (const [k, v] of [...u.notes].sort()) noteLines.push(`- ${k}: ${int(v)}`)
  out.push('Counters from the union step:')
  out.push('')
  out.push(noteLines.join('\n') || 'none')
  out.push('')
  out.push(
    [
      `- Billing / account / IU key as stored: ${billingMismatch.length === 0 ? 'every backfilled row carries the stored values (checked on all matched keys)' : billingMismatch.join('; ')}.`,
      `- \`account\` stored on a non-Max row and dropped (the column rule: Max rows only): ${int(accountDropped)}.`,
      `- Argo billing \`openrouter\` is not in the writer's vocabulary and is written \`unknown\`: ${int(note('billing openrouter -> unknown'))} rows.`,
      `- Malformed or non-object \`raw\` JSON (kept as \`{legacyRaw: ...}\` or dropped): ${int(u.malformedRaw)}.`,
      `- Rows not backfilled: ${u.skippedList.length === 0 ? 'none (every ts parses, every grain is known)' : ''}`,
    ].join('\n'),
  )
  out.push('')
  if (u.skippedList.length > 0) {
    out.push(
      table(
        ['source', 'source_id', 'ts', 'grain', 'cost'],
        u.skippedList
          .slice(0, 100)
          .map((s) => [s.source, `\`${s.sourceId}\``, s.ts, s.grain, s.costUsd ?? 'NULL']),
      ),
    )
    out.push('')
  }
  out.push('### Zero-token marker rows (kept as records)')
  out.push('')
  out.push(
    table(
      ['source', 'rows', 'old cost $', 'now NULL'],
      [...markers].sort().map(([s, m]) => [s, int(m.rows), usd(m.cost), int(m.nullCost)]),
    ),
  )
  out.push('')
  out.push(
    `Total: ${int([...markers.values()].reduce((s, m) => s + m.rows, 0))} rows with no tokens of any kind.`,
  )
  out.push('')
  out.push('### Model normalization (old `model_norm` -> new `model`)')
  out.push('')
  const mc = [...modelChange].sort((x, y) => y[1] - x[1])
  out.push(
    mc.length
      ? table(
          ['old -> new', 'rows'],
          mc.slice(0, 25).map(([k, v]) => [k, int(v)]),
        )
      : 'no model name changed',
  )
  if (mc.length > 25)
    out.push(
      `\n${mc.length - 25} further pairs not shown (${int(mc.slice(25).reduce((s, x) => s + x[1], 0))} rows).`,
    )
  out.push('')

  out.push('## Lanes (records)')
  out.push('')
  const laneBy = new Map<string, string[]>()
  for (const r of lanes) {
    const l = laneBy.get(r.source) ?? []
    l.push(`${r.lane} ${int(r.n)}`)
    laneBy.set(r.source, l)
  }
  out.push(
    table(
      ['source', 'lane: rows'],
      [...laneBy].map(([s, l]) => [s, l.join(', ')]),
    ),
  )
  out.push('')
  out.push('## Sessions')
  out.push('')
  out.push(
    `${int(sessionTotal.n)} sessions, ${int(sessionTotal.linked)} records linked to one. Sessions whose first/last timestamp differ from the span of their records: ${int(spanBad.n)}.`,
  )
  out.push('')
  const sessLines = new Map<string, string[]>()
  for (const r of sessionRows) {
    const l = sessLines.get(r.source) ?? []
    l.push(`${r.lane} ${int(r.n)}`)
    sessLines.set(r.source, l)
  }
  out.push(
    table(
      ['source', 'lane: sessions'],
      [...sessLines].map(([s, l]) => [s, l.join(', ')]),
    ),
  )
  out.push('')
  out.push('Samples:')
  out.push('')
  out.push(sampleLines.join('\n'))
  out.push('')

  out.push('## Runs and idempotency')
  out.push('')
  out.push(
    table(
      [
        'run at (UTC)',
        'seconds',
        'rows in union',
        'inserted',
        'skipped: row exists (insert-only)',
        'rows written or changed',
      ],
      ctx.runs.map((r) => [
        r.at.slice(0, 19),
        r.seconds,
        int(r.union),
        int(r.inserted),
        int(r.skippedExisting),
        r.changed === null ? 'n/a' : int(r.changed),
      ]),
    ),
  )
  out.push('')
  out.push(
    '"Written or changed" counts rows whose `ingested_at` equals the run\'s start stamp: the writer touches `ingested_at` only on an insert or a real change, so a second run must show 0. ' +
      'Per-source counts of the last run:',
  )
  out.push('')
  out.push(
    table(
      ['source', 'rows', 'inserted', 'skipped: row exists'],
      [...ctx.counts]
        .sort()
        .map(([s, c]) => [s, int(c.items), int(c.inserted), int(c.skippedExisting)]),
    ),
  )
  out.push('')

  if (bad.length > 0) {
    out.push('## Buckets that do not close')
    out.push('')
    out.push(
      table(
        ['bucket', 'diff cents', 'token deltas rows/in/out/cr/cw/reasoning'],
        bad.map((l) => [l.k, l.diffCents, l.tokenDelta.join('/')]),
      ),
    )
    out.push('')
  }
  if (missing.length > 0) out.push(`Missing after write: ${missing.join(', ')}\n`)
  if (tokenMismatch.length > 0)
    out.push(
      `Token mismatches (first ${tokenMismatch.length}):\n\n${tokenMismatch.map((t) => `- ${t}`).join('\n')}\n`,
    )

  mkdirSync(dirname(ctx.outFile), { recursive: true })
  writeFileSync(ctx.outFile, `${out.join('\n')}\n`)
  console.log(
    `[backfill] proof written to ${ctx.outFile}: ${bad.length} of ${lines.length} buckets do not close`,
  )
}
