#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chooseRow, monthOf, toRecord, type Chosen, type StoredRow } from "../src/backfill.ts";
import { connect } from "../src/pg/connect.ts";
import { sessionKey } from "../src/pg/sessions.ts";
import { upsertRecords, type WriterRecord } from "../src/pg/writer.ts";
import { buildProof, Measures, type Item, type RunLog, type SourceCounts, type Union } from "./backfill-proof.ts";

// One-off, re-runnable, idempotent backfill of the usage history into usage.records / usage.sessions:
//   (a) Argo's table argo.usage_record on the VPS, dumped read-only (COPY ... TO STDOUT over ssh) into a scratch dir,
//   (b) the local SQLite archive, opened read-only.
// Union by (source, source_id): the SQLite row wins (exact cost, 1h split, IU key), else Argo's. Pure mapping and the
// dedup rule live in src/backfill.ts. Historical billing / account / iu_key go through the writer as stored. Nothing is
// ever deleted: a re-run upserts, and a second run writes 0 changed rows. Proof document: scripts/backfill-proof.ts.
//
//   bun scripts/backfill-argo.ts [--dry-run] [--reuse-dump] [--no-proof] [--proof <file.md>] [--dir <scratch>]
//                                [--db <usage.db>] [--insert-only <source,source|all>] [--batch <n>]

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const DIR = arg("dir") ?? process.env.USAGE_BACKFILL_DIR ?? join(homedir(), ".local/share/usage-tracker/backfill");
const SQLITE = arg("db") ?? process.env.USAGE_DB ?? join(homedir(), ".local/share/usage-tracker/usage.db");
const DUMP = join(DIR, "argo-usage-record.copy-text");
const META = join(DIR, "argo-usage-record.meta.json");
const BATCH = Number(arg("batch") ?? 2000);
/** Sources whose own writer now owns the rows: the backfill only inserts what is absent and never touches a session row. */
const INSERT_ONLY = new Set((arg("insert-only") ?? "agent-workflows").split(",").filter(Boolean));
/** `--insert-only all`: the cutover re-run, once the live pipeline owns every source, adds only what is missing. */
const insertOnlyFor = (source: string): boolean => INSERT_ONLY.has("all") || INSERT_ONLY.has(source);
const DRY = flag("dry-run");
const PROOF = flag("no-proof") ? null : (arg("proof") ?? join(import.meta.dir, `../docs/backfill/${new Date().toISOString().slice(0, 10)}-argo-usage-record.md`));

const log = (msg: string): void => console.log(`[backfill] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const DUMP_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
COPY (SELECT row_to_json(t)::text FROM (
  SELECT id, source, source_id, grain, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts, model, model_norm,
         project, billing, machine, outcome, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, cost_usd, cost_source, raw, ingested_at, sub_tool, duration_ms, workspace, account, iu_key
  FROM argo.usage_record ORDER BY source, source_id, id) t) TO STDOUT;
ROLLBACK;
`;

/** Stream a consistent snapshot of Argo's table into DUMP (COPY text format: only backslashes are doubled in the JSON). */
async function dumpArgo(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const part = `${DUMP}.part`;
  const t0 = Date.now();
  const proc = Bun.spawn(["ssh", "vps", "docker exec -i postgres psql -X -q -At -v ON_ERROR_STOP=1 -U jkrumm -d postgres"], {
    stdin: new Blob([DUMP_SQL]),
    stdout: Bun.file(part),
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`argo dump failed: ssh exit ${code}`);
  renameSync(part, DUMP);
  writeFileSync(META, JSON.stringify({ dumpedAt: new Date().toISOString(), bytes: statSync(DUMP).size }));
  log(`dumped Argo table to ${DUMP} (${(statSync(DUMP).size / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

function argoRow(j: Record<string, unknown>): StoredRow {
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
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
    costUsd: typeof j.cost_usd === "number" ? j.cost_usd : null,
    costSource: (j.cost_source as string) ?? "none",
    raw: (j.raw as Record<string, unknown> | null) ?? null,
    ingestedAt: j.ingested_at as string,
    subTool: s(j.sub_tool),
    durationMs: typeof j.duration_ms === "number" ? j.duration_ms : null,
    workspace: s(j.workspace),
    account: s(j.account),
    iuKey: s(j.iu_key),
  };
}

/** The whole SQLite archive in one read transaction, keyed source -> source_id. */
function loadSqlite(): { rows: Map<string, Map<string, StoredRow>>; count: number } {
  const db = new Database(SQLITE, { readonly: true });
  const rows = new Map<string, Map<string, StoredRow>>();
  let count = 0;
  db.exec("BEGIN");
  const q = db.query(
    `SELECT source, source_id, grain, ts, model, model_norm, project, billing, machine, outcome, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, cost_usd, cost_source, raw,
            ingested_at, sub_tool, duration_ms, workspace, account, iu_key FROM usage_record`,
  );
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
    };
    let m = rows.get(row.source);
    if (!m) rows.set(row.source, (m = new Map()));
    m.set(row.sourceId, row);
    count++;
  }
  db.exec("COMMIT");
  db.close();
  return { rows, count };
}

const bucket = (source: string, ts: string): string => `${source}|${monthOf(ts)}`;
const get = (m: Map<string, Measures>, k: string): Measures => {
  let v = m.get(k);
  if (!v) m.set(k, (v = new Measures()));
  return v;
};

/** Argo rows that also exist in SQLite keep only what the proof reads (their raw/project are never written). */
const slim = (r: StoredRow): StoredRow => ({ ...r, raw: null, project: null });

async function buildUnion(): Promise<Union> {
  const { rows: sqlite, count: sqliteCount } = loadSqlite();
  log(`SQLite snapshot: ${sqliteCount} rows`);
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
    dumpedAt: JSON.parse(readFileSync(META, "utf8")).dumpedAt,
    malformedRaw: 0,
    notes: new Map(),
  };
  const note = (k: string, n = 1): void => void u.notes.set(k, (u.notes.get(k) ?? 0) + n);
  const seen = new Set<string>();

  const accept = (source: string, chosen: Chosen): void => {
    const row = chosen.row;
    const a = chosen.argo;
    for (const f of chosen.borrowed) note(`${source}: ${f} empty in SQLite, filled from Argo`);
    if (a && chosen.origin === "sqlite") {
      if (a.ts !== row.ts) note(Date.parse(a.ts) === Date.parse(row.ts) ? "ts spelled differently in both stores (same instant)" : "ts DIFFERS between the stores (different instant)");
      if (a.project !== row.project) note("project differs (Argo keeps a shortened form; the SQLite path is written)");
      if ((a.model ?? null) !== (row.model ?? null)) note("raw model differs between the stores");
      if (a.machine !== row.machine) note("machine differs between the stores (SQLite value written)");
      if (a.inputTokens !== row.inputTokens || a.outputTokens !== row.outputTokens || a.cacheReadTokens !== row.cacheReadTokens || a.cacheWriteTokens !== row.cacheWriteTokens || a.reasoningTokens !== row.reasoningTokens) note("token counts differ between the stores");
      if (a.billing !== row.billing) note("billing differs between the stores");
    }
    if (row.grain === "request" || row.grain === "step") note(`${source}: grain ${row.grain} written as ${row.grain === "step" ? "session" : "message"}`);
    if (row.billing !== "max" && row.billing !== "iu" && row.billing !== "anthropic-api" && row.billing !== "unknown") note(`billing ${row.billing} -> unknown`);
    if (row.machine === null || row.machine === "") note(`${source}: machine empty (stored NULL)`);
    if (Number.isNaN(Date.parse(row.ts)) || !storedGrainOk(row.grain)) {
      get(u.skipped, bucket(source, row.ts)).add(row);
      u.skippedList.push({ source, sourceId: row.sourceId, ts: row.ts, grain: row.grain, costUsd: row.costUsd });
      return;
    }
    if (chosen.origin === "sqlite" && chosen.argo) chosen.argo = slim(chosen.argo);
    u.items.push({ source, sourceId: row.sourceId, chosen });
  };

  const flush = (group: StoredRow[]): void => {
    const first = group[0] as StoredRow;
    const source = first.source;
    const key = `${source}\0${first.sourceId}`;
    seen.add(key);
    for (const r of group) get(u.argo, bucket(source, r.ts)).add(r);
    const chosen = chooseRow(group, sqlite.get(source)?.get(first.sourceId)) as Chosen;
    if (chosen.dropped.length > 0) {
      for (const d of chosen.dropped) get(u.dropped, bucket(source, d.ts)).add(d);
      u.dupGroups.push({
        source,
        sourceId: first.sourceId,
        kept: chosen.argo?.machine ?? null,
        keptReason: chosen.origin === "sqlite" ? "sqlite" : "argo",
        dropped: chosen.dropped.map((d) => ({ machine: d.machine, costUsd: d.costUsd })),
      });
    }
    accept(source, chosen);
  };

  const rl = createInterface({ input: createReadStream(DUMP, { encoding: "utf8" }), crlfDelay: Infinity });
  let group: StoredRow[] = [];
  let groupKey = "";
  for await (const line of rl) {
    if (!line) continue;
    const row = argoRow(JSON.parse(line.replace(/\\\\/g, "\\")));
    u.argoRows++;
    const key = `${row.source}\0${row.sourceId}`;
    if (key !== groupKey && group.length > 0) {
      flush(group);
      group = [];
    }
    groupKey = key;
    group.push(row);
  }
  if (group.length > 0) flush(group);
  log(`Argo dump: ${u.argoRows} rows`);

  for (const [source, m] of sqlite) {
    for (const row of m.values()) {
      if (seen.has(`${source}\0${row.sourceId}`)) continue;
      get(u.sqliteOnly, bucket(source, row.ts)).add(row);
      accept(source, chooseRow([], row) as Chosen);
    }
  }
  return u;
}

/** Records grouped by session (a record without one is its own group), packed into batches of at most `max` records. */
function sessionBatches(source: string, records: WriterRecord[], max = 500): WriterRecord[][] {
  const groups = new Map<string, WriterRecord[]>();
  for (const r of records) {
    const key = sessionKey(source, { sourceId: r.sourceId, grain: r.grain, raw: r.raw }) ?? `\0${r.sourceId}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const batches: WriterRecord[][] = [];
  let cur: WriterRecord[] = [];
  for (const g of groups.values()) {
    if (g.length > max) log(`${source}: a session of ${g.length} records exceeds one writer chunk; its span may stay narrow under insert-only`);
    if (cur.length > 0 && cur.length + g.length > max) {
      batches.push(cur);
      cur = [];
    }
    cur.push(...g);
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

const storedGrainOk = (g: string): boolean => ["message", "request", "session", "step"].includes(g);

async function main(): Promise<void> {
  const t0 = Date.now();
  if (!flag("reuse-dump") || !existsSync(DUMP) || !existsSync(META)) await dumpArgo();
  else log(`reusing dump ${DUMP}`);

  const u = await buildUnion();
  const bySource = new Map<string, Item[]>();
  for (const it of u.items) {
    let l = bySource.get(it.source);
    if (!l) bySource.set(it.source, (l = []));
    l.push(it);
  }
  log(`union: ${u.items.length} rows to write (${u.skippedList.length} skipped: unparseable ts or unknown grain)`);
  const sum = (m: Map<string, Measures>, f: (x: Measures) => number): number => [...m.values()].reduce((n, x) => n + f(x), 0);
  log(
    `Argo $${sum(u.argo, (x) => x.cost).toFixed(2)} | duplicate keys dropped ${sum(u.dropped, (x) => x.rows)} rows $${sum(u.dropped, (x) => x.cost).toFixed(2)} | ` +
      `SQLite-only ${sum(u.sqliteOnly, (x) => x.rows)} rows $${sum(u.sqliteOnly, (x) => x.cost).toFixed(2)} | ` +
      `Argo-only ${u.items.filter((i) => i.chosen.origin === "argo").length} rows`,
  );
  for (const [k, v] of [...u.notes].sort()) log(`  ${k}: ${v}`);
  for (const s of u.skippedList.slice(0, 20)) log(`  skipped ${s.source}/${s.sourceId} ts=${JSON.stringify(s.ts)} grain=${s.grain}`);

  const sql = connect();
  const counts = new Map<string, SourceCounts>();
  const runNow = new Date();
  try {
    if (DRY) {
      log("dry run: no writes");
      for (const [source, list] of [...bySource].sort()) counts.set(source, { items: list.length, inserted: 0, skippedExisting: 0 });
    } else {
      for (const [source, list] of [...bySource].sort()) {
        list.sort((a, b) => (a.chosen.row.ts < b.chosen.row.ts ? -1 : a.chosen.row.ts > b.chosen.row.ts ? 1 : a.sourceId < b.sourceId ? -1 : 1));
        const insertOnly = insertOnlyFor(source);
        const c: SourceCounts = { items: list.length, inserted: 0, skippedExisting: 0 };
        const toRecords = (slice: Item[]): WriterRecord[] =>
          slice.map((it) => {
            const m = toRecord(it.chosen.row);
            if ("skip" in m) throw new Error(`unreachable: ${source}/${it.sourceId} ${m.skip}`);
            if (m.malformedRaw) u.malformedRaw++;
            it.chosen.row.raw = null;
            return m.record;
          });
        // Insert-only never widens a stored session, so a session created by this run must arrive in one call: batches of
        // whole sessions, at most the writer's chunk of 500 records.
        const batches = insertOnly ? sessionBatches(source, toRecords(list)) : null;
        const total = batches ? batches.length : Math.ceil(list.length / BATCH);
        for (let b = 0; b < total; b++) {
          const records = batches ? (batches[b] as WriterRecord[]) : toRecords(list.slice(b * BATCH, (b + 1) * BATCH));
          const { newRows } = await upsertRecords(sql, source, records, { now: runNow, insertOnly });
          c.inserted += newRows;
          if (insertOnly) c.skippedExisting += records.length - newRows;
          if (b % 25 === 24) log(`${source}: ${Math.min((b + 1) * BATCH, list.length)}/${list.length}`);
        }
        counts.set(source, c);
        log(`${source}: ${c.items} rows, ${c.inserted} new${insertOnly ? `, ${c.skippedExisting} skipped: row exists (insert-only)` : ""}`);
      }
    }
    const seconds = (Date.now() - t0) / 1000;
    let changed: number | null = null;
    if (!DRY) {
      const [r] = await sql`SELECT count(*)::int AS n FROM usage.records WHERE ingested_at = ${runNow.toISOString()}::timestamptz`;
      changed = r.n;
    }
    log(`written/changed rows this run (ingested_at = run start): ${changed ?? "n/a (dry run)"}`);
    console.log(
      JSON.stringify({
        dryRun: DRY,
        argoRows: u.argoRows,
        sqliteRows: u.sqliteRows,
        union: u.items.length,
        skipped: u.skippedList.length,
        changedRows: changed,
        perSource: Object.fromEntries(counts),
        seconds: Math.round(seconds),
      }),
    );
    if (!DRY) {
      const inserted = [...counts.values()].reduce((n, c) => n + c.inserted, 0);
      const skippedExisting = [...counts.values()].reduce((n, c) => n + c.skippedExisting, 0);
      const entry: RunLog = { at: runNow.toISOString(), dryRun: false, seconds: Math.round(seconds), union: u.items.length, changed, inserted, skippedExisting };
      appendFileSync(join(DIR, "runs.jsonl"), `${JSON.stringify(entry)}\n`);
      if (PROOF) {
        const runs = readFileSync(join(DIR, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunLog);
        await buildProof({ sql, union: u, counts, runNow, changed, seconds, runs, outFile: PROOF });
      }
    }
  } finally {
    await sql.close();
  }
}

await main();
