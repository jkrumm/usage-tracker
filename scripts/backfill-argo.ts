#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { chooseRow, monthOf, toRecord, type Chosen, type StoredRow } from '../src/backfill.ts'
import { connect } from '../src/pg/connect.ts'
import { upsertRecords, type WriterRecord } from '../src/pg/writer.ts'
import {
  buildProof,
  Measures,
  type Item,
  type RunLog,
  type SourceCounts,
  type Union,
} from './backfill-proof.ts'

// One-off, re-runnable, idempotent backfill of the usage history into usage.records / usage.sessions:
//   (a) Argo's table argo.usage_record on the VPS, dumped read-only (COPY ... TO STDOUT over ssh) into a scratch dir,
//   (b) the local SQLite archive, opened read-only.
// Union by (source, source_id): the SQLite row wins (exact cost, 1h split, IU key), else Argo's. Pure mapping and the
// dedup rule live in src/backfill.ts. Historical billing / account / iu_key go through the writer as stored. Nothing is
// ever deleted. The default is INSERT-ONLY for every source: a row that exists is left alone (the live pipeline owns it),
// a session widens its span and fills NULL attributes, so a re-run only adds what is missing. Overwriting is the
// exception: `--overwrite <source,source|all>` rewrites those sources' rows whose content differs (the initial load, or a
// repair of one source), and refuses to run while the ingest LaunchAgent is loaded unless `--force` / FORCE=1, because the
// live pipeline rewrites the same keys. After the write loop it runs usage.flag_gateway_duplicates() (idempotent).
// Proof document: scripts/backfill-proof.ts.
//
//   bun scripts/backfill-argo.ts [--dry-run] [--reuse-dump] [--no-proof] [--proof <file.md>] [--dir <scratch>]
//                                [--db <usage.db>] [--overwrite <source,source|all>] [--force] [--batch <n>]

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const DIR =
  arg('dir') ??
  process.env.USAGE_BACKFILL_DIR ??
  join(homedir(), '.local/share/usage-tracker/backfill')
const SQLITE =
  arg('db') ?? process.env.USAGE_DB ?? join(homedir(), '.local/share/usage-tracker/usage.db')
const DUMP = join(DIR, 'argo-usage-record.copy-text')
const META = join(DIR, 'argo-usage-record.meta.json')
const BATCH = Number(arg('batch') ?? 2000)
/** Sources whose rows this run may overwrite; every other source is insert-only (the default: none). */
const OVERWRITE = new Set((arg('overwrite') ?? '').split(',').filter(Boolean))
const insertOnlyFor = (source: string): boolean => !(OVERWRITE.has('all') || OVERWRITE.has(source))
const AGENT_LABEL = 'com.jkrumm.usage-tracker'
const FORCE = flag('force') || process.env.FORCE === '1'
const DRY = flag('dry-run')
const PROOF = flag('no-proof')
  ? null
  : (arg('proof') ??
    join(
      import.meta.dir,
      `../docs/backfill/${new Date().toISOString().slice(0, 10)}-argo-usage-record.md`,
    ))

const log = (msg: string): void =>
  console.log(`[backfill] ${new Date().toISOString().slice(11, 19)} ${msg}`)

const DUMP_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
COPY (SELECT row_to_json(t)::text FROM (
  SELECT id, source, source_id, grain, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts, model, model_norm,
         project, billing, machine, outcome, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, cost_usd, cost_source, raw, ingested_at, sub_tool, duration_ms, workspace, account, iu_key
  FROM argo.usage_record ORDER BY source, source_id, id) t) TO STDOUT;
ROLLBACK;
`

/** Stream a consistent snapshot of Argo's table into DUMP (COPY text format: only backslashes are doubled in the JSON). */
async function dumpArgo(): Promise<void> {
  mkdirSync(DIR, { recursive: true })
  const part = `${DUMP}.part`
  const t0 = Date.now()
  const proc = Bun.spawn(
    [
      'ssh',
      'vps',
      'docker exec -i postgres psql -X -q -At -v ON_ERROR_STOP=1 -U jkrumm -d postgres',
    ],
    {
      stdin: new Blob([DUMP_SQL]),
      stdout: Bun.file(part),
      stderr: 'inherit',
    },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(`argo dump failed: ssh exit ${code}`)
  renameSync(part, DUMP)
  writeFileSync(
    META,
    JSON.stringify({ dumpedAt: new Date().toISOString(), bytes: statSync(DUMP).size }),
  )
  log(
    `dumped Argo table to ${DUMP} (${(statSync(DUMP).size / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  )
}

function argoRow(j: Record<string, unknown>): StoredRow {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    id: j.id as number,
    source: j.source as string,
    sourceId: j.source_id as string,
    grain: j.grain as string,
    ts: j.ts as string,
    model: s(j.model),
    modelNorm: s(j.model_norm),
    project: s(j.project),
    billing: j.billing as string,
    machine: s(j.machine),
    outcome: s(j.outcome),
    inputTokens: n(j.input_tokens),
    outputTokens: n(j.output_tokens),
    cacheReadTokens: n(j.cache_read_tokens),
    cacheWriteTokens: n(j.cache_write_tokens),
    cacheWrite1hTokens: 0,
    reasoningTokens: n(j.reasoning_tokens),
    costUsd: typeof j.cost_usd === 'number' ? j.cost_usd : null,
    costSource: (j.cost_source as string) ?? 'none',
    raw: (j.raw as Record<string, unknown> | null) ?? null,
    ingestedAt: j.ingested_at as string,
    subTool: s(j.sub_tool),
    durationMs: typeof j.duration_ms === 'number' ? j.duration_ms : null,
    workspace: s(j.workspace),
    account: s(j.account),
    iuKey: s(j.iu_key),
  }
}

/** The whole SQLite archive in one read transaction, keyed source -> source_id. */
function loadSqlite(): { rows: Map<string, Map<string, StoredRow>>; count: number } {
  const db = new Database(SQLITE, { readonly: true })
  const rows = new Map<string, Map<string, StoredRow>>()
  let count = 0
  db.exec('BEGIN')
  const q = db.query(
    `SELECT source, source_id, grain, ts, model, model_norm, project, billing, machine, outcome, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, cost_usd, cost_source, raw,
            ingested_at, sub_tool, duration_ms, workspace, account, iu_key FROM usage_record`,
  )
  for (const r of q.iterate() as Iterable<Record<string, unknown>>) {
    const row: StoredRow = {
      source: r.source as string,
      sourceId: r.source_id as string,
      grain: r.grain as string,
      ts: r.ts as string,
      model: (r.model as string | null) ?? null,
      modelNorm: (r.model_norm as string | null) ?? null,
      project: (r.project as string | null) ?? null,
      billing: r.billing as string,
      machine: (r.machine as string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      cacheWrite1hTokens: r.cache_write_1h_tokens as number,
      reasoningTokens: r.reasoning_tokens as number,
      costUsd: (r.cost_usd as number | null) ?? null,
      costSource: r.cost_source as string,
      raw: (r.raw as string | null) ?? null,
      ingestedAt: r.ingested_at as string,
      subTool: (r.sub_tool as string | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      workspace: (r.workspace as string | null) || null,
      account: (r.account as string | null) || null,
      iuKey: (r.iu_key as string | null) || null,
    }
    let m = rows.get(row.source)
    if (!m) rows.set(row.source, (m = new Map()))
    m.set(row.sourceId, row)
    count++
  }
  db.exec('COMMIT')
  db.close()
  return { rows, count }
}

const bucket = (source: string, ts: string): string => `${source}|${monthOf(ts)}`
const get = (m: Map<string, Measures>, k: string): Measures => {
  let v = m.get(k)
  if (!v) m.set(k, (v = new Measures()))
  return v
}

/** Argo rows that also exist in SQLite keep only what the proof reads (their raw/project are never written). */
const slim = (r: StoredRow): StoredRow => ({ ...r, raw: null, project: null })

async function buildUnion(): Promise<Union> {
  const { rows: sqlite, count: sqliteCount } = loadSqlite()
  log(`SQLite snapshot: ${sqliteCount} rows`)
  const u: Union = {
    items: [],
    argoRows: 0,
    sqliteRows: sqliteCount,
    argo: new Map(),
    dropped: new Map(),
    sqliteOnly: new Map(),
    skipped: new Map(),
    skippedList: [],
    dupGroups: [],
    dumpedAt: JSON.parse(readFileSync(META, 'utf8')).dumpedAt,
    malformedRaw: 0,
    notes: new Map(),
  }
  const note = (k: string, n = 1): void => void u.notes.set(k, (u.notes.get(k) ?? 0) + n)
  const seen = new Set<string>()

  const accept = (source: string, chosen: Chosen): void => {
    const row = chosen.row
    const a = chosen.argo
    for (const f of chosen.borrowed) note(`${source}: ${f} empty in SQLite, filled from Argo`)
    if (a && chosen.origin === 'sqlite') {
      if (a.ts !== row.ts)
        note(
          Date.parse(a.ts) === Date.parse(row.ts)
            ? 'ts spelled differently in both stores (same instant)'
            : 'ts DIFFERS between the stores (different instant)',
        )
      if (a.project !== row.project)
        note('project differs (Argo keeps a shortened form; the SQLite path is written)')
      if ((a.model ?? null) !== (row.model ?? null)) note('raw model differs between the stores')
      if (a.machine !== row.machine)
        note('machine differs between the stores (SQLite value written)')
      if (
        a.inputTokens !== row.inputTokens ||
        a.outputTokens !== row.outputTokens ||
        a.cacheReadTokens !== row.cacheReadTokens ||
        a.cacheWriteTokens !== row.cacheWriteTokens ||
        a.reasoningTokens !== row.reasoningTokens
      )
        note('token counts differ between the stores')
      if (a.billing !== row.billing) note('billing differs between the stores')
    }
    if (row.grain === 'request' || row.grain === 'step')
      note(
        `${source}: grain ${row.grain} written as ${row.grain === 'step' ? 'session' : 'message'}`,
      )
    if (
      row.billing !== 'max' &&
      row.billing !== 'iu' &&
      row.billing !== 'anthropic-api' &&
      row.billing !== 'unknown'
    )
      note(`billing ${row.billing} -> unknown`)
    if (row.machine === null || row.machine === '') note(`${source}: machine empty (stored NULL)`)
    if (Number.isNaN(Date.parse(row.ts)) || !storedGrainOk(row.grain)) {
      get(u.skipped, bucket(source, row.ts)).add(row)
      u.skippedList.push({
        source,
        sourceId: row.sourceId,
        ts: row.ts,
        grain: row.grain,
        costUsd: row.costUsd,
      })
      return
    }
    if (chosen.origin === 'sqlite' && chosen.argo) chosen.argo = slim(chosen.argo)
    u.items.push({ source, sourceId: row.sourceId, chosen })
  }

  const flush = (group: StoredRow[]): void => {
    const first = group[0] as StoredRow
    const source = first.source
    const key = `${source}\0${first.sourceId}`
    seen.add(key)
    for (const r of group) get(u.argo, bucket(source, r.ts)).add(r)
    const chosen = chooseRow(group, sqlite.get(source)?.get(first.sourceId)) as Chosen
    if (chosen.dropped.length > 0) {
      for (const d of chosen.dropped) get(u.dropped, bucket(source, d.ts)).add(d)
      u.dupGroups.push({
        source,
        sourceId: first.sourceId,
        kept: chosen.argo?.machine ?? null,
        keptReason: chosen.origin === 'sqlite' ? 'sqlite' : 'argo',
        dropped: chosen.dropped.map((d) => ({ machine: d.machine, costUsd: d.costUsd })),
      })
    }
    accept(source, chosen)
  }

  const rl = createInterface({
    input: createReadStream(DUMP, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let group: StoredRow[] = []
  let groupKey = ''
  for await (const line of rl) {
    if (!line) continue
    const row = argoRow(JSON.parse(line.replace(/\\\\/g, '\\')))
    u.argoRows++
    const key = `${row.source}\0${row.sourceId}`
    if (key !== groupKey && group.length > 0) {
      flush(group)
      group = []
    }
    groupKey = key
    group.push(row)
  }
  if (group.length > 0) flush(group)
  log(`Argo dump: ${u.argoRows} rows`)

  for (const [source, m] of sqlite) {
    for (const row of m.values()) {
      if (seen.has(`${source}\0${row.sourceId}`)) continue
      get(u.sqliteOnly, bucket(source, row.ts)).add(row)
      accept(source, chooseRow([], row) as Chosen)
    }
  }
  return u
}

const storedGrainOk = (g: string): boolean => ['message', 'request', 'session', 'step'].includes(g)

/** The ingest LaunchAgent is loaded (launchctl print succeeds): it rewrites the keys an overwrite run would. */
function ingestAgentLoaded(): boolean {
  if (typeof process.getuid !== 'function') return false
  const r = Bun.spawnSync(['launchctl', 'print', `gui/${process.getuid()}/${AGENT_LABEL}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return r.exitCode === 0
}

async function main(): Promise<void> {
  const t0 = Date.now()
  if (OVERWRITE.size > 0 && !DRY && !FORCE && ingestAgentLoaded()) {
    console.error(
      `[backfill] refusing to overwrite (${[...OVERWRITE].join(',')}): the ingest LaunchAgent ${AGENT_LABEL} is loaded and would rewrite the same keys. ` +
        'Unload it (make uninstall-agent) or pass --force / FORCE=1. The default (insert-only) is always safe.',
    )
    process.exit(2)
  }
  if (!flag('reuse-dump') || !existsSync(DUMP) || !existsSync(META)) await dumpArgo()
  else log(`reusing dump ${DUMP}`)

  const u = await buildUnion()
  const bySource = new Map<string, Item[]>()
  for (const it of u.items) {
    let l = bySource.get(it.source)
    if (!l) bySource.set(it.source, (l = []))
    l.push(it)
  }
  log(
    `union: ${u.items.length} rows to write (${u.skippedList.length} skipped: unparseable ts or unknown grain)`,
  )
  const sum = (m: Map<string, Measures>, f: (x: Measures) => number): number =>
    [...m.values()].reduce((n, x) => n + f(x), 0)
  log(
    `Argo $${sum(u.argo, (x) => x.cost).toFixed(2)} | duplicate keys dropped ${sum(u.dropped, (x) => x.rows)} rows $${sum(u.dropped, (x) => x.cost).toFixed(2)} | ` +
      `SQLite-only ${sum(u.sqliteOnly, (x) => x.rows)} rows $${sum(u.sqliteOnly, (x) => x.cost).toFixed(2)} | ` +
      `Argo-only ${u.items.filter((i) => i.chosen.origin === 'argo').length} rows`,
  )
  for (const [k, v] of [...u.notes].sort()) log(`  ${k}: ${v}`)
  for (const s of u.skippedList.slice(0, 20))
    log(`  skipped ${s.source}/${s.sourceId} ts=${JSON.stringify(s.ts)} grain=${s.grain}`)

  const sql = connect()
  const counts = new Map<string, SourceCounts>()
  const runNow = new Date()
  try {
    if (DRY) {
      log('dry run: no writes')
      for (const [source, list] of [...bySource].sort())
        counts.set(source, { items: list.length, inserted: 0, skippedExisting: 0 })
    } else {
      for (const [source, list] of [...bySource].sort()) {
        list.sort((a, b) =>
          a.chosen.row.ts < b.chosen.row.ts
            ? -1
            : a.chosen.row.ts > b.chosen.row.ts
              ? 1
              : a.sourceId < b.sourceId
                ? -1
                : 1,
        )
        const insertOnly = insertOnlyFor(source)
        const c: SourceCounts = { items: list.length, inserted: 0, skippedExisting: 0 }
        const toRecords = (slice: Item[]): WriterRecord[] =>
          slice.map((it) => {
            const m = toRecord(it.chosen.row)
            if ('skip' in m) throw new Error(`unreachable: ${source}/${it.sourceId} ${m.skip}`)
            if (m.malformedRaw) u.malformedRaw++
            it.chosen.row.raw = null
            return m.record
          })
        const total = Math.ceil(list.length / BATCH)
        for (let b = 0; b < total; b++) {
          const records = toRecords(list.slice(b * BATCH, (b + 1) * BATCH))
          const { newRows } = await upsertRecords(sql, source, records, { now: runNow, insertOnly })
          c.inserted += newRows
          if (insertOnly) c.skippedExisting += records.length - newRows
          if (b % 25 === 24)
            log(`${source}: ${Math.min((b + 1) * BATCH, list.length)}/${list.length}`)
        }
        counts.set(source, c)
        log(
          `${source}: ${c.items} rows, ${c.inserted} new${insertOnly ? `, ${c.skippedExisting} skipped: row exists (insert-only)` : ''}`,
        )
      }
    }
    const seconds = (Date.now() - t0) / 1000
    let changed: number | null = null
    let flagged: number | null = null
    if (!DRY) {
      const [f] = await sql`SELECT usage.flag_gateway_duplicates()::int AS n`
      flagged = f.n
      log(`gateway mirror duplicates newly flagged: ${flagged}`)
      const [r] =
        await sql`SELECT count(*)::int AS n FROM usage.records WHERE ingested_at = ${runNow.toISOString()}::timestamptz`
      changed = r.n
    }
    log(`written/changed rows this run (ingested_at = run start): ${changed ?? 'n/a (dry run)'}`)
    console.log(
      JSON.stringify({
        dryRun: DRY,
        argoRows: u.argoRows,
        sqliteRows: u.sqliteRows,
        union: u.items.length,
        skipped: u.skippedList.length,
        changedRows: changed,
        flaggedDuplicates: flagged,
        perSource: Object.fromEntries(counts),
        seconds: Math.round(seconds),
      }),
    )
    if (!DRY) {
      const inserted = [...counts.values()].reduce((n, c) => n + c.inserted, 0)
      const skippedExisting = [...counts.values()].reduce((n, c) => n + c.skippedExisting, 0)
      const entry: RunLog = {
        at: runNow.toISOString(),
        dryRun: false,
        seconds: Math.round(seconds),
        union: u.items.length,
        changed,
        inserted,
        skippedExisting,
      }
      appendFileSync(join(DIR, 'runs.jsonl'), `${JSON.stringify(entry)}\n`)
      if (PROOF) {
        const runs = readFileSync(join(DIR, 'runs.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as RunLog)
        await buildProof({ sql, union: u, counts, runNow, changed, seconds, runs, outFile: PROOF })
      }
    }
  } finally {
    await sql.close()
  }
}

await main()
