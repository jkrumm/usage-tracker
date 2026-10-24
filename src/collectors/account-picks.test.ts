import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { collectPicks } from "./account-picks.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

let dir: string;
let db: Database;
let savedPicks: string | undefined;
let file: string;

const line = (ts: string, picked = "me") =>
  `${JSON.stringify({ ts, lane: "wave", picked, reason: "home", stale: false, iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } })}\n`;

beforeEach(() => {
  savedPicks = process.env.USAGE_ACCOUNT_PICKS;
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-picks-"));
  file = join(dir, "picks.jsonl");
  process.env.USAGE_ACCOUNT_PICKS = file;
  db = openDb(join(dir, "usage.db"));
});

afterEach(() => {
  db.close();
  if (savedPicks === undefined) delete process.env.USAGE_ACCOUNT_PICKS;
  else process.env.USAGE_ACCOUNT_PICKS = savedPicks;
  rmSync(dir, { recursive: true, force: true });
});

describe("collectPicks", () => {
  test("incremental by offset, skips malformed lines and a half-written tail", async () => {
    writeFileSync(file, `${line("2026-10-24T16:00:00.000Z")}not json\n{"ts":"x"}\n`);
    expect(await collectPicks(db)).toBe(1);
    appendFileSync(file, `${line("2026-10-24T16:01:00.000Z", "spill")}${line("2026-10-24T16:02:00.000Z").slice(0, 20)}`);
    expect(await collectPicks(db)).toBe(1);
    expect(await collectPicks(db)).toBe(0);
    const rows = db.query<{ picked: string; snapshot: string; stale: number }, []>("SELECT picked, snapshot, stale FROM account_pick ORDER BY ts").all();
    expect(rows.map((r) => r.picked)).toEqual(["me", "spill"]);
    expect(JSON.parse(rows[0]!.snapshot)).toEqual({ iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } });
    expect(rows[0]!.stale).toBe(0);
  });

  test("a truncated file resets the offset", async () => {
    writeFileSync(file, line("2026-10-24T16:00:00.000Z") + line("2026-10-24T16:01:00.000Z"));
    expect(await collectPicks(db)).toBe(2);
    writeFileSync(file, line("2026-10-24T17:00:00.000Z"));
    expect(await collectPicks(db)).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM account_pick").get()!.n).toBe(3);
  });

  test("maps legacy ids a/b to iu/me in picked and snapshot keys; spill stays", async () => {
    const legacy = (ts: string, picked: string) =>
      `${JSON.stringify({ ts, lane: "fan", picked, reason: "spill", stale: false, a: { s: 1, w: 2 }, b: { s: 3, w: 4 } })}\n`;
    writeFileSync(file, legacy("2026-10-24T10:00:00.000Z", "a") + legacy("2026-10-24T10:01:00.000Z", "b") + legacy("2026-10-24T10:02:00.000Z", "spill"));
    expect(await collectPicks(db)).toBe(3);
    const rows = db.query<{ picked: string; snapshot: string }, []>("SELECT picked, snapshot FROM account_pick ORDER BY ts").all();
    expect(rows.map((r) => r.picked)).toEqual(["iu", "me", "spill"]);
    expect(JSON.parse(rows[0]!.snapshot)).toEqual({ iu: { s: 1, w: 2 }, me: { s: 3, w: 4 } });
  });
});
