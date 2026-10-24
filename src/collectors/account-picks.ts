import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCursor } from "../db.ts";
import { currentMachine } from "../machine.ts";
import { readNewLines } from "./fs-incremental.ts";

// The dotfiles account picker appends one JSON line per decision to picks.jsonl.
// Read incrementally by byte offset (kept in collector_state under CURSOR_KEY,
// like the other file collectors) into account_pick; synced to Argo separately.

const CURSOR_KEY = "account-picks";

function picksPath(): string {
  return process.env.USAGE_ACCOUNT_PICKS ?? join(homedir(), ".local", "share", "claude-accounts", "picks.jsonl");
}

interface PickLine {
  ts: string;
  lane: string;
  picked: string;
  reason: string;
  stale?: boolean;
  [account: string]: unknown;
}

/** Parse a picks.jsonl line into a row, or null when malformed. */
export function parsePick(line: string): { ts: number; lane: string; picked: string; reason: string; stale: number; snapshot: string } | null {
  let p: PickLine;
  try {
    p = JSON.parse(line) as PickLine;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const ts = typeof p.ts === "string" ? Date.parse(p.ts) : Number.NaN;
  if (Number.isNaN(ts) || typeof p.lane !== "string" || typeof p.picked !== "string") return null;
  const { ts: _ts, lane: _lane, picked: _picked, reason: _reason, stale: _stale, ...snapshot } = p;
  return {
    ts,
    lane: p.lane,
    picked: p.picked,
    reason: typeof p.reason === "string" ? p.reason : "",
    stale: p.stale ? 1 : 0,
    snapshot: JSON.stringify(snapshot),
  };
}

/** Ingest new picks; returns the number of new rows. */
export async function collectPicks(db: Database, opts: { full?: boolean } = {}): Promise<number> {
  const path = picksPath();
  if (!existsSync(path)) return 0;

  const size = statSync(path).size;
  let from = opts.full ? 0 : Number.parseInt(loadCursor(db, CURSOR_KEY) ?? "0", 10) || 0;
  if (size < from) from = 0; // truncated or rotated

  const chunk = await readNewLines(path, from, size);
  const offset = chunk?.offset ?? from;

  const machine = currentMachine();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO account_pick (ts, lane, picked, reason, stale, snapshot, machine)
     VALUES ($ts, $lane, $picked, $reason, $stale, $snapshot, $machine)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const line of chunk?.lines ?? []) {
      const pick = parsePick(line);
      if (!pick) continue;
      added += stmt.run({ $ts: pick.ts, $lane: pick.lane, $picked: pick.picked, $reason: pick.reason, $stale: pick.stale, $snapshot: pick.snapshot, $machine: machine }).changes;
    }
    db.prepare(
      `INSERT INTO collector_state (source, cursor, last_run_at, last_status, records_total)
       VALUES (?, ?, datetime('now'), 'ok', 0)
       ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, last_run_at = excluded.last_run_at, last_status = 'ok'`,
    ).run(CURSOR_KEY, String(offset));
  })();
  return added;
}
