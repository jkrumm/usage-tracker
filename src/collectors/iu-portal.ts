import type { Database } from "bun:sqlite";
import { loadCursor, saveState } from "../db.ts";
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
// `iuPortalFreshness`.

export const PORTAL_SOURCE = "iu-portal";
const REFRESH_MS = 4 * 3_600_000;
const KEY_REF = "op://common/anthropic/API_KEY";
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
export type PortalFetcher = () => Promise<PortalFetch>;

interface PortalDoc {
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

export function readPortalState(db: Database): PortalState {
  const raw = loadCursor(db, PORTAL_SOURCE);
  if (!raw) return EMPTY_STATE;
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<PortalState>) };
  } catch {
    return EMPTY_STATE;
  }
}

function writePortalState(db: Database, state: PortalState, status: "ok" | "error", note: string): void {
  saveState(db, PORTAL_SOURCE, { result: { records: [], cursor: JSON.stringify(state), note }, status, processed: 0 });
}

/** Freshness entry for `health`: the portal has kept no usage_record rows. */
export const iuPortalFreshness = {
  source: PORTAL_SOURCE,
  staleAfterHours: 48,
  available: () => !iumacDisabled(),
  newest: (db: Database): string | null => {
    const ok = readPortalState(db).lastOk;
    return ok === null ? null : new Date(ok).toISOString();
  },
};

/** Key from the secrets cache, piped into the scrape on iumac. */
export const sshFetcher: PortalFetcher = async () => {
  const keyProc = Bun.spawn(["secrets-run", "read", KEY_REF], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: KEY_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const key = (await new Response(keyProc.stdout).text()).trim();
  if (((await keyProc.exited) !== 0) || !key) return { code: 1, stdout: "", stderr: "API key unresolvable via secrets-run" };

  const proc = Bun.spawn(["ssh", ...SSH_OPTS, iumacHost(), REMOTE_CMD], {
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

function storeDaily(db: Database, doc: PortalDoc, fetchedAt: number): number {
  const first = doc.periods[0];
  const last = doc.periods.at(-1);
  if (!first || !last) return 0;
  const insert = db.prepare(
    `INSERT INTO iu_portal_cost (day, label, row, cost_usd, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, label, row) DO UPDATE SET cost_usd = excluded.cost_usd, fetched_at = excluded.fetched_at`,
  );
  let written = 0;
  db.transaction(() => {
    // The report is the whole truth for its window: a cell that went away is gone.
    db.run("DELETE FROM iu_portal_cost WHERE day >= ? AND day <= ?", [first, last]);
    for (const row of doc.rows) {
      for (const [day, usd] of Object.entries(row.cells)) {
        insert.run(day, row.label, row.row, usd, fetchedAt);
        written++;
      }
    }
  })();
  return written;
}

/** Monthly totals, minus the first period: a "3 Months" window starts mid-month. */
function storeMonthly(db: Database, doc: PortalDoc, fetchedAt: number): void {
  const upsert = db.prepare(
    `INSERT INTO iu_portal_total (month, total_usd, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (month) DO UPDATE SET total_usd = excluded.total_usd, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const month of doc.periods.slice(1)) {
      const total = doc.rows.reduce((sum, r) => sum + (r.cells[month] ?? 0), 0);
      upsert.run(month, Math.round(total * 100) / 100, fetchedAt);
    }
  })();
}

export interface CollectPortalOptions {
  fetch?: PortalFetcher;
  now?: number;
  /** Ignore the 4 h throttle. */
  force?: boolean;
}

/**
 * Fetch and store the portal report, at most once per 4 h. Returns the number
 * of daily cells written (0 when throttled, unreachable or failed). Never throws.
 */
export async function collectPortal(db: Database, opts: CollectPortalOptions = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const state = readPortalState(db);
  const sinceOk = state.lastOk === null ? Infinity : now - state.lastOk;
  const sinceAttempt = state.lastAttempt === null ? Infinity : now - state.lastAttempt;
  // An expired session needs a human, and a scrape that keeps failing launches a browser each
  // time: back both off. Only an unreachable MacBook is retried every run (it costs one ssh).
  const failBackoff =
    state.lastCode === SESSION_EXPIRED ? REFRESH_MS : state.lastCode === UNREACHABLE || !state.lastCode ? 0 : OTHER_FAILURE_BACKOFF_MS;
  const backoff = sinceAttempt < failBackoff;
  if (!opts.force && (sinceOk < REFRESH_MS || backoff)) return 0;
  if (iumacDisabled()) return 0;

  const fail = (reason: string, code: number): 0 => {
    log.warn(`iu-portal: ${reason}`);
    writePortalState(db, { ...state, lastAttempt: now, lastCode: code }, "error", reason);
    return 0;
  };

  try {
    const res = await (opts.fetch ?? sshFetcher)();
    if (res.code === SESSION_EXPIRED) return fail("session expired — run make iu-portal-login", res.code);
    if (res.code === UNREACHABLE) return fail("iumac unreachable (MacBook asleep or offline)", res.code);
    if (res.code !== 0) return fail(`scrape exited ${res.code}: ${res.stderr.trim().split("\n").at(-1) ?? ""}`, res.code);

    const docs = parseDocs(res.stdout);
    const daily = docs.find((d) => d.granularity === "daily");
    if (!daily) return fail("scrape returned no daily report", res.code);
    const written = storeDaily(db, daily, now);
    for (const d of docs) if (d.granularity === "monthly") storeMonthly(db, d, now);
    resolvePortalModels(db);
    writePortalState(
      db,
      { lastOk: now, lastAttempt: now, lastCode: 0, lastDay: daily.periods.at(-1) ?? null },
      "ok",
      `${written} cells`,
    );
    return written;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 1);
  }
}
