import type { Database } from "bun:sqlite";
import { argoConfig, postJson, type ArgoConfig } from "./argo.ts";
import { log } from "./log.ts";

// Push quota_sample / account_pick to Argo. `synced`: 0 = pending, 1 = pushed,
// -1 = quarantined (a row whose conversion throws is parked, never re-selected,
// so one bad row cannot wedge the table's sync forever).

const BATCH = 1000;

interface QuotaRow {
  rowid: number;
  account: string;
  sampled_at: number;
  machine: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_resets_at: number | null;
  auth_ok: number | null;
  exhausted_until: number | null;
  source: string | null;
}

interface PickRow {
  rowid: number;
  ts: number;
  lane: string;
  picked: string;
  reason: string;
  stale: number;
  snapshot: string | null;
  machine: string;
}

/** ISO string for epoch ms; throws RangeError on an out-of-range value. */
function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

const isoSec = (s: number | null): string | null => (s == null ? null : isoMs(s * 1000));

function parseSnapshot(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const quotaPayload = (r: QuotaRow) => ({
  account: r.account,
  sampledAt: isoMs(r.sampled_at),
  machine: r.machine,
  fiveHourPct: r.five_hour_pct,
  sevenDayPct: r.seven_day_pct,
  fiveHourResetsAt: isoSec(r.five_hour_resets_at),
  sevenDayResetsAt: isoSec(r.seven_day_resets_at),
  authOk: r.auth_ok == null ? null : r.auth_ok === 1,
  exhaustedUntil: isoSec(r.exhausted_until),
  source: r.source,
});

const pickPayload = (r: PickRow) => ({
  ts: isoMs(r.ts),
  lane: r.lane,
  picked: r.picked,
  reason: r.reason,
  stale: r.stale === 1,
  snapshot: parseSnapshot(r.snapshot),
  machine: r.machine,
});

async function pushTable<T extends { rowid: number }>(
  db: Database,
  cfg: ArgoConfig,
  t: { table: string; path: string; key: string; select: string; toPayload: (r: T) => unknown },
): Promise<number> {
  const mark = db.prepare(`UPDATE ${t.table} SET synced = ? WHERE rowid = ?`);
  let pushed = 0;
  for (;;) {
    const rows = db.query<T, [number]>(t.select).all(BATCH);
    if (rows.length === 0) return pushed;

    const items: unknown[] = [];
    const sent: T[] = [];
    for (const r of rows) {
      try {
        items.push(t.toPayload(r));
        sent.push(r);
      } catch (err) {
        mark.run(-1, r.rowid);
        log.warn(`sync: quarantined ${t.table} rowid ${r.rowid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sent.length > 0) {
      if ((await postJson(cfg, t.path, { [t.key]: items }, { tolerateMissing: true })) !== "ok") return pushed;
      db.transaction(() => {
        for (const r of sent) mark.run(1, r.rowid);
      })();
      pushed += sent.length;
    }
  }
}

/**
 * Push pending rows of both tables. A 404/405 (Argo endpoint not shipped) leaves
 * rows pending and is logged once per endpoint per run at info.
 */
export async function syncAccountTables(db: Database): Promise<{ quota: number; picks: number }> {
  const cfg = argoConfig();
  if (!cfg) return { quota: 0, picks: 0 };

  const quota = await pushTable<QuotaRow>(db, cfg, {
    table: "quota_sample",
    path: "/usage/quota-samples",
    key: "samples",
    select: `SELECT rowid, account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at,
                    seven_day_resets_at, auth_ok, exhausted_until, source
             FROM quota_sample WHERE synced = 0 ORDER BY rowid LIMIT ?`,
    toPayload: quotaPayload,
  });
  const picks = await pushTable<PickRow>(db, cfg, {
    table: "account_pick",
    path: "/usage/account-picks",
    key: "picks",
    select: `SELECT rowid, ts, lane, picked, reason, stale, snapshot, machine
             FROM account_pick WHERE synced = 0 ORDER BY rowid LIMIT ?`,
    toPayload: pickPayload,
  });
  if (quota > 0 || picks > 0) log.info(`sync: pushed ${quota} quota samples, ${picks} account picks`);
  return { quota, picks };
}
