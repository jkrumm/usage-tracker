import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { runIngest } from "../ingest.ts";
import { staleSources } from "../report.ts";
import { collectPortal, iuPortalFreshness, readPortalState, type PortalFetch } from "./iu-portal.ts";

const NOW = Date.parse("2026-10-26T08:00:00Z");
const H = 3_600_000;

const daily = {
  fetched_at: "2026-10-26T08:00:00Z",
  cost_center: "CC00000",
  total_usd: 7,
  granularity: "daily",
  periods: ["2026-10-25", "2026-10-26"],
  rows: [
    { label: "Claude Haiku 5 5 Eu", row: 1, cells: { "2026-10-25": 3, "2026-10-26": 2 } },
    { label: "Mystery Model", row: 2, cells: { "2026-10-26": 2 } },
  ],
};
const monthly = {
  ...daily,
  granularity: "monthly",
  periods: ["2026-08", "2026-09", "2026-10"],
  rows: [{ label: "Claude Haiku 5 5 Eu", row: 1, cells: { "2026-08": 9, "2026-09": 100, "2026-10": 5 } }],
};
const ok = (...docs: object[]): PortalFetch => ({ code: 0, stdout: docs.map((d) => JSON.stringify(d)).join("\n"), stderr: "" });

let dir: string;
let db: Database;
let prevRoot: string | undefined;
const latestFile = () => join(dir, "iu-portal", "latest.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-tracker-portal-"));
  prevRoot = process.env.IU_PORTAL_ROOT;
  process.env.IU_PORTAL_ROOT = join(dir, "iu-portal");
  db = openDb(join(dir, "usage.db"));
  db.run(
    `INSERT INTO usage_record (source, source_id, grain, ts, model, model_norm, billing, cost_usd, ingested_at)
     VALUES ('s', '1', 'message', '2026-10-26T01:00:00Z', 'claude-haiku-5-5-eu', 'claude-haiku-5-5', 'iu', 1, 'x')`,
  );
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.IU_PORTAL_ROOT;
  else process.env.IU_PORTAL_ROOT = prevRoot;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cost = () =>
  db.query("SELECT day, label, row, model, cost_usd FROM iu_portal_cost ORDER BY day, row").all();

describe("collectPortal", () => {
  test("stores non-zero cells, maps labels onto model_norm, keeps unmatched ones NULL", async () => {
    expect(await collectPortal(db, { now: NOW, fetch: async () => ok(daily, monthly) })).toBe(3);
    expect(cost()).toEqual([
      { day: "2026-10-25", label: "Claude Haiku 5 5 Eu", row: 1, model: "claude-haiku-5-5", cost_usd: 3 },
      { day: "2026-10-26", label: "Claude Haiku 5 5 Eu", row: 1, model: "claude-haiku-5-5", cost_usd: 2 },
      { day: "2026-10-26", label: "Mystery Model", row: 2, model: null, cost_usd: 2 },
    ]);
    // the first monthly period is a partial window and is dropped
    expect(db.query("SELECT month, total_usd FROM iu_portal_total ORDER BY month").all()).toEqual([
      { month: "2026-09", total_usd: 100 },
      { month: "2026-10", total_usd: 5 },
    ]);
    expect(readPortalState(db)).toMatchObject({ lastOk: NOW, lastCode: 0, lastDay: "2026-10-26" });
  });

  test("writes the schema-1 latest.json on success (dir created) and leaves it on failure", async () => {
    expect(existsSync(latestFile())).toBe(false);
    await collectPortal(db, { now: NOW, fetch: async () => ok(daily, monthly) });
    const written = readFileSync(latestFile(), "utf8");
    expect(JSON.parse(written)).toMatchObject({
      schema: 1,
      fetched_at: "2026-10-26T08:00:00Z",
      limit_usd: 500,
      window_days: 30,
      rolling30_usd: 7,
      can_spend_today_usd: 497,
    });
    expect(existsSync(`${latestFile()}.tmp`)).toBe(false);

    const failures: PortalFetch[] = [
      { code: 3, stdout: "", stderr: "session expired" },
      { code: 255, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "boom" },
      ok({ granularity: "daily" }),
    ];
    for (const [i, f] of failures.entries()) {
      await collectPortal(db, { now: NOW + (5 + i * 5) * H, force: true, fetch: async () => f });
      expect(readFileSync(latestFile(), "utf8")).toBe(written);
    }
  });

  test("latest fetch wins: a grown value is updated and a vanished cell removed", async () => {
    await collectPortal(db, { now: NOW, fetch: async () => ok(daily) });
    const next = { ...daily, rows: [{ ...daily.rows[0]!, cells: { "2026-10-25": 3, "2026-10-26": 4 } }] };
    await collectPortal(db, { now: NOW + 5 * H, fetch: async () => ok(next) });
    expect(cost().map((r) => (r as { cost_usd: number }).cost_usd)).toEqual([3, 4]);
  });

  test("throttled to one fetch per 4 h", async () => {
    let calls = 0;
    const fetch = async () => (calls++, ok(daily));
    await collectPortal(db, { now: NOW, fetch });
    expect(await collectPortal(db, { now: NOW + 3 * H, fetch })).toBe(0);
    await collectPortal(db, { now: NOW + 4 * H, fetch });
    expect(calls).toBe(2);
  });

  test("an unreachable MacBook retries next run and never throws; the old data stays", async () => {
    await collectPortal(db, { now: NOW, fetch: async () => ok(daily) });
    let calls = 0;
    const down = async () => (calls++, { code: 255, stdout: "", stderr: "ssh: connect failed" });
    expect(await collectPortal(db, { now: NOW + 5 * H, fetch: down })).toBe(0);
    expect(await collectPortal(db, { now: NOW + 5 * H + 900_000, fetch: down })).toBe(0);
    expect(calls).toBe(2);
    expect(cost()).toHaveLength(3);
    expect(readPortalState(db).lastOk).toBe(NOW);
  });

  test("an expired session backs off for 4 h instead of retrying every run", async () => {
    let calls = 0;
    const expired = async () => (calls++, { code: 3, stdout: "", stderr: "session expired" });
    await collectPortal(db, { now: NOW, fetch: expired });
    await collectPortal(db, { now: NOW + 900_000, fetch: expired });
    expect(calls).toBe(1);
    await collectPortal(db, { now: NOW + 4 * H, fetch: expired });
    expect(calls).toBe(2);
    expect(db.query("SELECT last_status, last_note FROM collector_state WHERE source = 'iu-portal'").get()).toEqual({
      last_status: "error",
      last_note: "session expired — run make iu-portal-login",
    });
  });

  test("any other failure backs off 1 h, an unreachable MacBook does not", async () => {
    let calls = 0;
    const broken = async () => (calls++, { code: 1, stdout: "", stderr: "boom" });
    await collectPortal(db, { now: NOW, fetch: broken });
    await collectPortal(db, { now: NOW + 900_000, fetch: broken });
    expect(calls).toBe(1);
    await collectPortal(db, { now: NOW + H, fetch: broken });
    expect(calls).toBe(2);
  });

  test("garbage output is a failure, not an exception, and writes nothing", async () => {
    expect(await collectPortal(db, { now: NOW, fetch: async () => ok({ granularity: "daily" }) })).toBe(0);
    expect(cost()).toEqual([]);
  });
});

describe("iuPortalFreshness", () => {
  test("health flags a portal that has not succeeded for 48 h, and one that never did", async () => {
    const at = new Date(NOW + 60 * H);
    expect(staleSources(db, [iuPortalFreshness], at).map((s) => s.source)).toEqual(["iu-portal"]);
    await collectPortal(db, { now: NOW, fetch: async () => ok(daily) });
    expect(staleSources(db, [iuPortalFreshness], new Date(NOW + 47 * H))).toEqual([]);
    expect(staleSources(db, [iuPortalFreshness], at).map((s) => s.source)).toEqual(["iu-portal"]);
  });
});

test("a failing portal fetch never fails the ingest run", async () => {
  const down = async () => ({ code: 255, stdout: "", stderr: "" });
  const summary = await runIngest(db, { collectors: [], accounts: false, portal: true, portalFetch: down });
  expect(summary.portal).toBe(0);
  const live = await runIngest(db, { collectors: [], accounts: false, portal: true, portalFetch: async () => ok(daily) });
  expect(live.portal).toBe(3);
});
