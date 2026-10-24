import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { syncAccountTables } from "./sync-account.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const ENV = ["ARGO_URL", "ARGO_TOKEN"] as const;
const M = "Test Machine (Override)";

let dir: string;
let db: Database;
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{ path: string; body: any }>;
let status: number;
const saved: Record<string, string | undefined> = {};

function seedQuota(sampledAt: number, over: Partial<{ resets: number }> = {}): void {
  db.prepare(
    `INSERT INTO quota_sample (account, sampled_at, machine, five_hour_pct, seven_day_pct, five_hour_resets_at,
       seven_day_resets_at, auth_ok, exhausted_until, source)
     VALUES ('iu', ?, ?, 10, 88, ?, 1793203200, 1, 1792870000, 'statusline')`,
  ).run(sampledAt, M, over.resets ?? 1792867800);
}

function seedPick(ts: number, over: Partial<{ snapshot: string }> = {}): void {
  db.prepare(
    `INSERT INTO account_pick (ts, lane, picked, reason, stale, snapshot, machine) VALUES (?, 'fan', 'spill', 'all-high', 1, ?, ?)`,
  ).run(ts, over.snapshot ?? '{"iu":{"s":90,"w":99}}', M);
}

const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-syncacct-"));
  db = openDb(join(dir, "usage.db"));
  calls = [];
  status = 200;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ path: new URL(req.url).pathname, body: await req.json() });
      return new Response("{}", { status });
    },
  });
  process.env.ARGO_URL = `http://localhost:${server.port}`;
  process.env.ARGO_TOKEN = "t";
});

afterEach(() => {
  server.stop(true);
  db.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("syncAccountTables", () => {
  test("payload shape and synced marking", async () => {
    seedQuota(2_000_000_000_000);
    seedPick(Date.parse("2026-10-24T16:53:12.316Z"));
    expect(await syncAccountTables(db)).toEqual({ quota: 1, picks: 1 });
    expect(calls.find((c) => c.path === "/usage/quota-samples")!.body.samples[0]).toEqual({
      account: "iu", sampledAt: new Date(2_000_000_000_000).toISOString(), machine: M,
      fiveHourPct: 10, sevenDayPct: 88, fiveHourResetsAt: new Date(1792867800_000).toISOString(),
      sevenDayResetsAt: new Date(1793203200_000).toISOString(), authOk: true,
      exhaustedUntil: new Date(1792870000_000).toISOString(), source: "statusline",
    });
    expect(calls.find((c) => c.path === "/usage/account-picks")!.body.picks[0]).toEqual({
      ts: "2026-10-24T16:53:12.316Z", lane: "fan", picked: "spill", reason: "all-high", stale: true,
      snapshot: { iu: { s: 90, w: 99 } }, machine: M,
    });
    calls.length = 0;
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(calls).toHaveLength(0);
  });

  test("404/405 leaves rows pending without throwing", async () => {
    seedQuota(2_000_000_000_000);
    seedPick(1_800_000_000_000);
    for (status of [404, 405]) expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(count("SELECT count(*) n FROM quota_sample WHERE synced = 0")).toBe(1);
    expect(count("SELECT count(*) n FROM account_pick WHERE synced = 0")).toBe(1);
  });

  test("batches of at most 1000", async () => {
    db.transaction(() => {
      for (let i = 0; i < 1500; i++) seedPick(1_800_000_000_000 + i);
    })();
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 1500 });
    expect(calls.map((c) => c.body.picks.length)).toEqual([1000, 500]);
  });

  test("a poison row is quarantined (synced=-1), the rest still push, and it is never re-selected", async () => {
    seedQuota(2_000_000_000_000);
    seedQuota(9e15); // new Date(9e15).toISOString() throws RangeError
    seedQuota(2_000_000_001_000, { resets: 9e15 }); // reset epoch out of range too
    expect(await syncAccountTables(db)).toEqual({ quota: 1, picks: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.samples).toHaveLength(1);
    expect(count("SELECT count(*) n FROM quota_sample WHERE synced = -1")).toBe(2);
    calls.length = 0;
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(calls).toHaveLength(0);
  });

  test("a batch of only poison rows posts nothing and terminates", async () => {
    seedQuota(9e15);
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(calls).toHaveLength(0);
    expect(count("SELECT count(*) n FROM quota_sample WHERE synced = -1")).toBe(1);
  });

  test("no ARGO_TOKEN = nothing pushed", async () => {
    delete process.env.ARGO_TOKEN;
    seedQuota(2_000_000_000_000);
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(calls).toHaveLength(0);
  });
});
