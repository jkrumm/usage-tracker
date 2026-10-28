import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildLatest } from "../../tools/iu-portal/latest.ts";
import type { PortalDocument } from "../../tools/iu-portal/parse.ts";
import { loadCursor, saveState } from "../db.ts";
import { DEFAULT_IU_KEY, IU_KEYS, type IuKey, type IuKeyDef } from "../iu-keys.ts";
import { log } from "../log.ts";
import { normalizeModel } from "../models.ts";
import { iumacDisabled, iumacHost, SSH_OPTS } from "../remote.ts";

// IU's own cost report, the number that counts against the employee cap. No API
// carries it: the self-service portal is scraped from the MacBook (IU-managed
// Chrome holds the Entra session) by tools/iu-portal/scrape.ts over ssh, the API
// key piped through stdin so it never touches disk. Not a usage_record source:
// rows go to iu_portal_cost / iu_portal_total. A MacBook that is asleep, a
// logged-out session or a broken scrape are all "skip and say why" — never a
// reason to fail the other collectors; `health` flags a stale source via
// `iuPortalFreshness`. Every successful ingest also writes latest.json here on the
// mini (the scrape wrote its twin on the MacBook): agent-gateway's OCR gate reads it.
//
// Every registered IU key (iu-keys.ts) has its own cap and its own report: the portal is
// asked once per key with that key typed into the form. Only the personal key's report
// feeds latest.json (OCR gate, Tinycast); the others pass `--no-latest` to the scrape.
// State is kept per key (`iu-portal` for the personal key, `iu-portal:<id>` otherwise).

export const PORTAL_SOURCE = "iu-portal";
const REFRESH_MS = 4 * 3_600_000;
const REMOTE_CMD = "cd ~/.local/share/iu-portal/tool && bun scrape.ts daily monthly";
const HANG_GUARD_MS = 5 * 60_000;
const KEY_TIMEOUT_MS = 30_000;
const OTHER_FAILURE_BACKOFF_MS = 3_600_000;
const UNREACHABLE = 255;
const SESSION_EXPIRED = 3;

export interface PortalFetch {
  code: number;
  stdout: string;
  stderr: string;
}
export type PortalFetcher = (key: IuKeyDef) => Promise<PortalFetch>;

interface PortalDoc {
  fetched_at?: string;
  granularity: "daily" | "monthly";
  periods: string[];
  rows: Array<{ label: string; row: number; cells: Record<string, number> }>;
}

interface PortalState {
  lastOk: number | null;
  lastAttempt: number | null;
  lastCode: number | null;
  /** Newest period of the last daily report: the portal's own "today". */
  lastDay: string | null;
}

const EMPTY_STATE: PortalState = { lastOk: null, lastAttempt: null, lastCode: null, lastDay: null };

const stateSource = (iuKey: IuKey) => (iuKey === DEFAULT_IU_KEY ? PORTAL_SOURCE : `${PORTAL_SOURCE}:${iuKey}`);

export function readPortalState(db: Database, iuKey: IuKey = DEFAULT_IU_KEY): PortalState {
  const raw = loadCursor(db, stateSource(iuKey));
  if (!raw) return EMPTY_STATE;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<PortalState>) };
  } catch {
    return EMPTY_STATE;
  }
}

function writePortalState(db: Database, iuKey: IuKey, state: PortalState, status: "ok" | "error", note: string): void {
  saveState(db, stateSource(iuKey), { result: { records: [], cursor: JSON.stringify(state), note }, status, processed: 0 });
}

/** Freshness entries for `health` (one per IU key): the portal has kept no usage_record rows. */
export const iuPortalFreshnessAll = IU_KEYS.map((def) => ({
  source: stateSource(def.id),
  staleAfterHours: 48,
  // A secondary key counts once it has been tried: a key never attempted (not deployed yet) is not
  // stale, but one that keeps failing (secret missing, rejected) goes red like the personal one.
  available: (db?: Database) =>
    !iumacDisabled() && (def.id === DEFAULT_IU_KEY || !db || readPortalState(db, def.id).lastAttempt !== null),
  newest: (db: Database): string | null => {
    const ok = readPortalState(db, def.id).lastOk;
    return ok === null ? null : new Date(ok).toISOString();
  },
}));

/** The personal key's entry: the one every IU consumer depends on. */
export const iuPortalFreshness = iuPortalFreshnessAll[0]!;

/** The key's secret from the cache (the 1Password account is only a cache namespace), piped into the scrape on iumac. */
export const sshFetcher: PortalFetcher = async (def) => {
  const keyProc = Bun.spawn(["secrets-run", "read", def.secretRef], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, OP_ACCOUNT: def.account },
    timeout: KEY_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const key = (await new Response(keyProc.stdout).text()).trim();
  if (((await keyProc.exited) !== 0) || !key) return { code: 1, stdout: "", stderr: `API key ${def.id} unresolvable via secrets-run` };

  // Only the personal report may become latest.json (Tinycast, the OCR gate).
  const remote = def.id === DEFAULT_IU_KEY ? REMOTE_CMD : `${REMOTE_CMD} --no-latest`;
  const proc = Bun.spawn(["ssh", ...SSH_OPTS, iumacHost(), remote], {
    stdin: Buffer.from(key),
    stdout: "pipe",
    stderr: "pipe",
    timeout: HANG_GUARD_MS,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** `IU_PORTAL_ROOT` mirrors scrape.ts, so tests and the MacBook share one override. */
function latestPath(): string {
  return join(process.env.IU_PORTAL_ROOT ?? join(homedir(), ".local/share/iu-portal"), "latest.json");
}

/** Same schema-1 document the scrape writes on iumac; atomic so a reader never sees half of it. */
function writeLatest(doc: PortalDoc, now: number): void {
  const path = latestPath();
  const full: PortalDocument = { fetched_at: new Date(now).toISOString(), cost_center: null, total_usd: 0, ...doc };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(buildLatest(full), null, 2)}\n`);
  renameSync(tmp, path);
}

function parseDocs(stdout: string): PortalDoc[] {
  const docs: PortalDoc[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const d = JSON.parse(line) as Partial<PortalDoc>;
    if ((d.granularity !== "daily" && d.granularity !== "monthly") || !Array.isArray(d.periods) || !Array.isArray(d.rows)) {
      throw new Error("malformed scrape document");
    }
    docs.push(d as PortalDoc);
  }
  return docs;
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Map each portal label onto our model_norm by comparing alphanumerics of the
 * label with those of every IU-billed raw model id and its normalization
 * (`Claude Haiku 5 5 Eu` = `claude-haiku-5-5-eu` → `claude-haiku-5-5`). Unmatched
 * labels stay NULL, which is the "spend we cannot see" signal.
 */
export function resolvePortalModels(db: Database): void {
  const known = new Map<string, string>();
  const rows = db
    .query<{ model: string | null; model_norm: string | null }, []>(
      "SELECT DISTINCT model, model_norm FROM usage_record WHERE billing = 'iu' AND model_norm IS NOT NULL",
    )
    .all();
  for (const r of rows) {
    const norm = r.model_norm!;
    known.set(alnum(norm), norm);
    if (r.model) known.set(alnum(r.model), norm);
    const viaRaw = r.model ? normalizeModel(r.model) : null;
    if (viaRaw) known.set(alnum(viaRaw), norm);
  }
  const labels = db.query<{ label: string }, []>("SELECT DISTINCT label FROM iu_portal_cost").all();
  const set = db.prepare("UPDATE iu_portal_cost SET model = ? WHERE label = ? AND model IS NOT ?");
  for (const { label } of labels) {
    const model = known.get(alnum(label)) ?? null;
    set.run(model, label, model);
  }
}

function storeDaily(db: Database, iuKey: IuKey, doc: PortalDoc, fetchedAt: number): number {
  const first = doc.periods[0];
  const last = doc.periods.at(-1);
  if (!first || !last) return 0;
  const insert = db.prepare(
    `INSERT INTO iu_portal_cost (iu_key, day, label, row, cost_usd, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (iu_key, day, label, row) DO UPDATE SET cost_usd = excluded.cost_usd, fetched_at = excluded.fetched_at`,
  );
  let written = 0;
  db.transaction(() => {
    // The report is the whole truth for its window: a cell that went away is gone.
    db.run("DELETE FROM iu_portal_cost WHERE iu_key = ? AND day >= ? AND day <= ?", [iuKey, first, last]);
    for (const row of doc.rows) {
      for (const [day, usd] of Object.entries(row.cells)) {
        insert.run(iuKey, day, row.label, row.row, usd, fetchedAt);
        written++;
      }
    }
  })();
  return written;
}

/** Monthly totals, minus the first period: a "3 Months" window starts mid-month. */
function storeMonthly(db: Database, iuKey: IuKey, doc: PortalDoc, fetchedAt: number): void {
  const upsert = db.prepare(
    `INSERT INTO iu_portal_total (iu_key, month, total_usd, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (iu_key, month) DO UPDATE SET total_usd = excluded.total_usd, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const month of doc.periods.slice(1)) {
      const total = doc.rows.reduce((sum, r) => sum + (r.cells[month] ?? 0), 0);
      upsert.run(iuKey, month, Math.round(total * 100) / 100, fetchedAt);
    }
  })();
}

export interface CollectPortalOptions {
  fetch?: PortalFetcher;
  now?: number;
  /** Ignore the 4 h throttle. */
  force?: boolean;
  /** Keys to fetch; every registered key by default. */
  keys?: readonly IuKeyDef[];
}

interface KeyOutcome {
  cells: number;
  /** The scrape's exit code, null when the key was throttled or the host is disabled. */
  code: number | null;
}

/**
 * Fetch and store each key's portal report, at most once per 4 h per key. Returns the
 * number of daily cells written (0 when throttled, unreachable or failed). Never throws.
 * A signed-out session or an unreachable MacBook is the same for every key, so it ends the pass.
 */
export async function collectPortal(db: Database, opts: CollectPortalOptions = {}): Promise<number> {
  let cells = 0;
  for (const def of opts.keys ?? IU_KEYS) {
    const out = await collectPortalKey(db, def, opts);
    cells += out.cells;
    if (out.code === SESSION_EXPIRED || out.code === UNREACHABLE) break;
  }
  return cells;
}

async function collectPortalKey(db: Database, def: IuKeyDef, opts: CollectPortalOptions): Promise<KeyOutcome> {
  const now = opts.now ?? Date.now();
  const state = readPortalState(db, def.id);
  const sinceOk = state.lastOk === null ? Infinity : now - state.lastOk;
  const sinceAttempt = state.lastAttempt === null ? Infinity : now - state.lastAttempt;
  // An expired session needs a human, and a scrape that keeps failing launches a browser each
  // time: back both off. Only an unreachable MacBook is retried every run (it costs one ssh).
  const failBackoff =
    state.lastCode === SESSION_EXPIRED ? REFRESH_MS : state.lastCode === UNREACHABLE || !state.lastCode ? 0 : OTHER_FAILURE_BACKOFF_MS;
  const backoff = sinceAttempt < failBackoff;
  if (!opts.force && (sinceOk < REFRESH_MS || backoff)) return { cells: 0, code: null };
  if (iumacDisabled()) return { cells: 0, code: null };

  const fail = (reason: string, code: number): KeyOutcome => {
    log.warn(`iu-portal[${def.id}]: ${reason}`);
    writePortalState(db, def.id, { ...state, lastAttempt: now, lastCode: code }, "error", reason);
    return { cells: 0, code };
  };

  try {
    const res = await (opts.fetch ?? sshFetcher)(def);
    if (res.code === SESSION_EXPIRED) return fail("session expired — run make iu-portal-login", res.code);
    if (res.code === UNREACHABLE) return fail("iumac unreachable (MacBook asleep or offline)", res.code);
    if (res.code !== 0) return fail(`scrape exited ${res.code}: ${res.stderr.trim().split("\n").at(-1) ?? ""}`, res.code);

    const docs = parseDocs(res.stdout);
    const daily = docs.find((d) => d.granularity === "daily");
    if (!daily) return fail("scrape returned no daily report", res.code);
    const written = storeDaily(db, def.id, daily, now);
    for (const d of docs) if (d.granularity === "monthly") storeMonthly(db, def.id, d, now);
    resolvePortalModels(db);
    writePortalState(
      db,
      def.id,
      { lastOk: now, lastAttempt: now, lastCode: 0, lastDay: daily.periods.at(-1) ?? null },
      "ok",
      `${written} cells`,
    );
    if (def.id === DEFAULT_IU_KEY) {
      try {
        writeLatest(daily, now);
      } catch (err) {
        log.warn(`iu-portal: latest.json not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { cells: written, code: 0 };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 1);
  }
}
