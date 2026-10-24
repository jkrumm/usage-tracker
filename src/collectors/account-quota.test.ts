import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { syncAccountTables } from "../sync.ts";
import { collectPicks } from "./account-picks.ts";
import { collectQuota, formatQuotaReport } from "./claude-quota.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const ENV = ["USAGE_CLAUDE_ACCOUNT_BIN", "USAGE_ACCOUNT_PICKS", "ARGO_URL", "ARGO_TOKEN"] as const;

const acct = (over: Record<string, unknown>) => ({
  id: "iu", plan: "max20x", enabled: true, five_hour: 10, seven_day: 88,
  five_hour_resets_at: 1792867800, seven_day_resets_at: 1793203200,
  age_s: 79, five_hour_age_s: 79, seven_day_age_s: 90, source: "statusline", auth_ok: true, exhausted_until: null,
  ...over,
});

let dir: string;
let db: Database;
const saved: Record<string, string | undefined> = {};

function fakeCli(accounts: unknown[]): void {
  const bin = join(dir, "claude-account");
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({ accounts })}\nJSON\n`);
  chmodSync(bin, 0o755);
  process.env.USAGE_CLAUDE_ACCOUNT_BIN = bin;
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-quota-"));
  process.env.USAGE_ACCOUNT_PICKS = join(dir, "picks.jsonl");
  db = openDb(join(dir, "usage.db"));
});

afterEach(() => {
  db.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("collectQuota", () => {
  test("dedupes an unchanged cached sample; sampled_at = now - min age", async () => {
    fakeCli([acct({})]);
    expect(await collectQuota(db, 1_000_000)).toBe(1);
    // same cache, ages grown by the elapsed 60 s -> same observation time
    fakeCli([acct({ five_hour_age_s: 139, seven_day_age_s: 150 })]);
    expect(await collectQuota(db, 1_060_000)).toBe(0);
    const row = db.query<{ sampled_at: number; n: number }, []>("SELECT sampled_at, count(*) n FROM quota_sample").get()!;
    expect(row).toEqual({ sampled_at: 1_000_000 - 79_000, n: 1 });
  });

  test("skips disabled accounts and accounts with both windows null", async () => {
    fakeCli([acct({ id: "a1", enabled: false }), acct({ id: "a2", five_hour: null, seven_day: null }), acct({ id: "me", seven_day: null })]);
    expect(await collectQuota(db, 5_000_000)).toBe(1);
    expect(db.query("SELECT account FROM quota_sample").all()).toEqual([{ account: "me" }]);
  });

  test("a missing CLI is a silent skip", async () => {
    process.env.USAGE_CLAUDE_ACCOUNT_BIN = join(dir, "nope");
    expect(await collectQuota(db)).toBe(0);
  });
});

describe("collectPicks", () => {
  const line = (ts: string, picked = "me") =>
    `${JSON.stringify({ ts, lane: "wave", picked, reason: "home", stale: false, iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } })}\n`;

  test("incremental by offset, skips malformed lines and a half-written tail", async () => {
    const f = process.env.USAGE_ACCOUNT_PICKS!;
    writeFileSync(f, `${line("2026-10-24T16:00:00.000Z")}not json\n{"ts":"x"}\n`);
    expect(await collectPicks(db)).toBe(1);
    appendFileSync(f, `${line("2026-10-24T16:01:00.000Z", "spill")}${line("2026-10-24T16:02:00.000Z").slice(0, 20)}`);
    expect(await collectPicks(db)).toBe(1);
    expect(await collectPicks(db)).toBe(0);
    const rows = db.query<{ picked: string; snapshot: string; stale: number }, []>("SELECT picked, snapshot, stale FROM account_pick ORDER BY ts").all();
    expect(rows.map((r) => r.picked)).toEqual(["me", "spill"]);
    expect(JSON.parse(rows[0]!.snapshot)).toEqual({ iu: { s: 10, w: 88 }, me: { s: 3, w: 0 } });
    expect(rows[0]!.stale).toBe(0);
  });

  test("maps legacy ids a/b to iu/me in picked and snapshot keys; spill stays", async () => {
    const f = process.env.USAGE_ACCOUNT_PICKS!;
    const legacy = (ts: string, picked: string) =>
      `${JSON.stringify({ ts, lane: "fan", picked, reason: "spill", stale: false, a: { s: 1, w: 2 }, b: { s: 3, w: 4 } })}\n`;
    writeFileSync(f, legacy("2026-10-24T10:00:00.000Z", "a") + legacy("2026-10-24T10:01:00.000Z", "b") + legacy("2026-10-24T10:02:00.000Z", "spill"));
    expect(await collectPicks(db)).toBe(3);
    const rows = db.query<{ picked: string; snapshot: string }, []>("SELECT picked, snapshot FROM account_pick ORDER BY ts").all();
    expect(rows.map((r) => r.picked)).toEqual(["iu", "me", "spill"]);
    expect(JSON.parse(rows[0]!.snapshot)).toEqual({ iu: { s: 1, w: 2 }, me: { s: 3, w: 4 } });
  });

  test("a truncated file resets the offset", async () => {
    const f = process.env.USAGE_ACCOUNT_PICKS!;
    writeFileSync(f, line("2026-10-24T16:00:00.000Z") + line("2026-10-24T16:01:00.000Z"));
    expect(await collectPicks(db)).toBe(2);
    writeFileSync(f, line("2026-10-24T17:00:00.000Z"));
    expect(await collectPicks(db)).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM account_pick").get()!.n).toBe(3);
  });

  test("report summarises series and picks", async () => {
    fakeCli([acct({})]);
    await collectQuota(db);
    writeFileSync(process.env.USAGE_ACCOUNT_PICKS!, line(new Date().toISOString()));
    await collectPicks(db);
    const out = formatQuotaReport(db);
    expect(out).toContain("iu");
    expect(out).toContain("5h min/max/last=10/10/10%");
    expect(out).toContain("wave");
  });
});

describe("syncAccountTables", () => {
  let server: ReturnType<typeof Bun.serve>;
  let calls: Array<{ path: string; body: any }>;
  let status: number;

  beforeEach(() => {
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
  afterEach(() => server.stop(true));

  async function seed(): Promise<void> {
    fakeCli([acct({ exhausted_until: 1792870000 })]);
    await collectQuota(db, 2_000_000_000_000);
    writeFileSync(process.env.USAGE_ACCOUNT_PICKS!, `${JSON.stringify({ ts: "2026-10-24T16:53:12.316Z", lane: "fan", picked: "spill", reason: "all-high", stale: true, iu: { s: 90, w: 99 } })}\n`);
    await collectPicks(db);
  }

  test("payload shape and synced marking", async () => {
    await seed();
    expect(await syncAccountTables(db)).toEqual({ quota: 1, picks: 1 });
    const q = calls.find((c) => c.path === "/usage/quota-samples")!.body.samples[0];
    expect(q).toEqual({
      account: "iu", sampledAt: new Date(2_000_000_000_000 - 79_000).toISOString(), machine: "Test Machine (Override)",
      fiveHourPct: 10, sevenDayPct: 88, fiveHourResetsAt: new Date(1792867800_000).toISOString(),
      sevenDayResetsAt: new Date(1793203200_000).toISOString(), authOk: true,
      exhaustedUntil: new Date(1792870000_000).toISOString(), source: "statusline",
    });
    expect(calls.find((c) => c.path === "/usage/account-picks")!.body.picks[0]).toEqual({
      ts: "2026-10-24T16:53:12.316Z", lane: "fan", picked: "spill", reason: "all-high", stale: true,
      snapshot: { iu: { s: 90, w: 99 } }, machine: "Test Machine (Override)",
    });
    calls.length = 0;
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(calls).toHaveLength(0);
  });

  test("404/405 leaves rows unsynced without throwing", async () => {
    await seed();
    status = 404;
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    status = 405;
    expect(await syncAccountTables(db)).toEqual({ quota: 0, picks: 0 });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM quota_sample WHERE synced = 0").get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM account_pick WHERE synced = 0").get()!.n).toBe(1);
  });
});
