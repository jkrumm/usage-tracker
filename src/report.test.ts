import type { SQL } from "bun";
import { beforeEach, expect, test } from "bun:test";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import { upsertRecords } from "./pg/writer.ts";
import { saveState } from "./pg/state.ts";
import { formatSources, formatStats, GROUP_BY_DIMS, sourceStatus, stats, unpricedByModel } from "./report.ts";
import type { UsageRecord } from "./types.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const rec = (sourceId: string, o: Partial<UsageRecord> = {}): UsageRecord => ({
  sourceId,
  grain: "message",
  ts: "2026-10-27T10:00:00.000Z",
  model: "claude-sonnet-5",
  project: "/Users/jkrumm/SourceRoot/argo/apps/api",
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 5000,
  cacheWriteTokens: 30,
  cacheWrite1hTokens: 10,
  reasoningTokens: 0,
  authoritativeCostUsd: 1,
  ...o,
});

describePg("report (Postgres)", () => {
  const pg = migratedDb();
  let sql: SQL;

  beforeEach(async () => {
    sql = await pg.reset();
    await upsertRecords(sql, "claude-code", [
      rec("c1", { subTool: "wave", machine: "mini" }),
      rec("c2", { ts: "2026-10-28T10:00:00.000Z", subTool: "fan", machine: "mini" }),
      rec("c3", { ts: "2026-10-28T11:00:00.000Z", outcome: "error", inputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, authoritativeCostUsd: 0 }),
    ]);
    await upsertRecords(sql, "opencode", [
      rec("o1", { model: "kimi-k2.6", project: "/Users/jkrumm/IuRoot/api", authoritativeCostUsd: 3, raw: { iuKey: "athena-team" } }),
      rec("o2", { model: "no-such-model", authoritativeCostUsd: null }),
    ]);
  });

  const byKey = async (by: (typeof GROUP_BY_DIMS)[number]) => Object.fromEntries((await stats(sql, { by })).map((r) => [r.key, r.records]));

  test("every --by dimension groups successful requests only, on the new column names", async () => {
    expect(GROUP_BY_DIMS).toEqual(["source", "model", "billing", "day", "machine", "lane", "account", "iu_key", "repo"]);
    expect(await byKey("source")).toEqual({ "claude-code": 2, opencode: 2 });
    expect(await byKey("model")).toEqual({ "claude-sonnet-5": 2, "kimi-k2.6": 1, "no-such-model": 1 });
    expect(await byKey("billing")).toEqual({ max: 2, api_key: 2 });
    expect(await byKey("day")).toEqual({ "2026-10-27": 3, "2026-10-28": 1 });
    expect(await byKey("machine")).toEqual({ mini: 2, "Test Machine (Override)": 2 });
    expect(await byKey("lane")).toEqual({ wave_mother: 1, fan_worker: 1, interactive: 2 });
    expect(await byKey("account")).toEqual({ iu: 2, "(n/a)": 2 });
    expect(await byKey("iu_key")).toEqual({ personal: 1, "athena-team": 1, "(n/a)": 2 });
    expect(await byKey("repo")).toEqual({ argo: 3, "iu/api": 1 });
  });

  test("sums tokens (cache writes of both TTLs, no cache reads) and cost per group", async () => {
    const [row] = (await stats(sql, { by: "source" })).filter((r) => r.key === "claude-code");
    expect(row).toEqual({ key: "claude-code", records: 2, input: 200, output: 20, cacheWrite: 60, reasoning: 0, costUsd: 2 });
    expect(formatStats(await stats(sql, { by: "billing" }), "billing")).toContain("TOTAL");
  });

  test("--since keeps the last N days only", async () => {
    expect(await stats(sql, { by: "source", sinceDays: 1 })).toEqual([]);
    expect((await stats(sql, { by: "source", sinceDays: 100000 })).length).toBe(2);
  });

  test("unpricedByModel names the models no price covers", async () => {
    expect(await unpricedByModel(sql)).toEqual([{ model: "no-such-model", rows: 1 }]);
  });

  test("sources lists the collector bookkeeping next to the error rate of its rows", async () => {
    await saveState(sql, "claude-code", { cursor: "c", status: "ok", note: "fine" });
    await saveState(sql, "opencode", { cursor: null, status: "error", note: "boom" });
    const rows = await sourceStatus(sql);
    expect(rows.map((r) => [r.source, r.records, r.lastStatus, r.errors, r.total])).toEqual([
      ["claude-code", 3, "ok", 1, 3],
      ["opencode", 2, "error", 0, 2],
    ]);
    const text = formatSources(rows);
    expect(text).toContain("claude-code");
    expect(text).toMatch(/33\.3%/);
    expect(text).toContain("boom");
  });
});
