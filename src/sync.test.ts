import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "./db.ts";
import { sync } from "./sync.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const ENV = ["ARGO_URL", "ARGO_TOKEN"] as const;

let dir: string;
let db: Database;
let realFetch: typeof fetch;
let paths: string[];
const saved: Record<string, string | undefined> = {};

/** Route fetch: usage always 200; account endpoints answered by `account`. */
function mockFetch(account: (path: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return path === "/usage/records" ? new Response("{}") : account(path);
  }) as unknown as typeof fetch;
}

function seed(): void {
  upsertRecords(db, "claude-code", [
    { sourceId: "s1", grain: "message", ts: "2026-10-24T10:00:00.000Z", model: "claude-sonnet-5", project: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  ]);
  db.exec(
    `INSERT INTO quota_sample (account, sampled_at, machine, five_hour_pct) VALUES ('iu', 1800000000000, 'm', 5);
     INSERT INTO account_pick (ts, lane, picked, reason, stale, snapshot, machine) VALUES (1800000000000, 'fan', 'me', 'home', 0, '{}', 'm')`,
  );
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  realFetch = globalThis.fetch;
  paths = [];
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-sync-"));
  db = openDb(join(dir, "usage.db"));
  process.env.ARGO_URL = "http://argo.test";
  process.env.ARGO_TOKEN = "t";
  seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("sync result is independent of the account endpoints", () => {
  const cases: Array<[string, (p: string) => Response | Promise<Response>]> = [
    ["404", () => new Response("", { status: 404 })],
    ["500", () => new Response("boom", { status: 500 })],
    ["network failure", () => Promise.reject(new TypeError("connection refused"))],
  ];
  for (const [name, account] of cases) {
    test(`usage rows push and the result is unchanged on ${name}`, async () => {
      mockFetch(account);
      expect(await sync(db)).toEqual({ pushed: 1, batches: 1 });
      expect(paths[0]).toBe("/usage/records");
      expect(paths).toContain("/usage/quota-samples");
      expect(db.query<{ n: number }, []>("SELECT count(*) n FROM usage_record WHERE synced_at IS NOT NULL").get()!.n).toBe(1);
    });
  }

  test("a throw inside the account push is caught", async () => {
    mockFetch(() => new Response("{}"));
    db.exec("DROP TABLE quota_sample");
    expect(await sync(db)).toEqual({ pushed: 1, batches: 1 });
  });

  test("a usage failure still reports its own result", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await sync(db)).toEqual({ pushed: 0, batches: 0 });
  });
});
