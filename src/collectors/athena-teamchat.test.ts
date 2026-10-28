import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "../db.ts";
import type { Logger } from "../types.ts";
import { athenaTeamchatCollector, toRecord, type AthenaRow } from "./athena-teamchat.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";
const log: Logger = { info() {}, warn() {}, error() {} };

const row = (over: Partial<AthenaRow> = {}): AthenaRow => ({
  kind: "turn",
  id: 1,
  ts: "2026-10-27T10:00:00+00:00",
  touched: "2026-10-27T10:00:00+00:00",
  tool: "chat-turn:chat",
  ok: true,
  tokens_in: 100,
  tokens_out: 20,
  cache_read: 5000,
  cache_write: 0,
  cost: 0.0123,
  ms: 4200,
  ...over,
});

describe("athena-teamchat collector", () => {
  test("maps a turn: tokens as-is, OpenCode's cost authoritative, no model", () => {
    expect(toRecord(row())).toMatchObject({
      sourceId: "turn:1",
      ts: "2026-10-27T10:00:00.000Z",
      model: null,
      subTool: "chat-turn:chat",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5000,
      durationMs: 4200,
      outcome: "ok",
      authoritativeCostUsd: 0.0123,
    });
  });

  test("a failed call is an error row; source ids never collide across the three tables", () => {
    expect(toRecord(row({ kind: "llm", id: 1, ok: false })).outcome).toBe("error");
    const ids = [row(), row({ kind: "llm" }), row({ kind: "title" })].map((r) => toRecord(r).sourceId);
    expect(new Set(ids).size).toBe(3);
  });

  test("first run reads everything, later runs overlap three days behind the newest row", async () => {
    const seen: string[] = [];
    const c = athenaTeamchatCollector(async (since) => {
      seen.push(since);
      return [
        row({ ts: "2026-10-27T10:00:00Z", touched: "2026-10-27T10:00:00Z" }),
        row({ id: 2, ts: "2026-10-28T08:00:00Z", touched: "2026-10-28T09:00:00Z" }),
      ];
    });
    const first = await c.collect({ cursor: null, full: false, log });
    expect(seen[0]).toBe("1970-01-01T00:00:00Z");
    expect(JSON.parse(first.cursor!)).toEqual({ newest: "2026-10-28T09:00:00.000Z" });
    await c.collect({ cursor: first.cursor, full: false, log });
    expect(seen[1]).toBe("2026-10-25T09:00:00.000Z");
    await c.collect({ cursor: first.cursor, full: true, log });
    expect(seen[2]).toBe("1970-01-01T00:00:00Z");
  });

  test("the cursor follows when a row last changed, so a turn that ends late is re-read", async () => {
    const c = athenaTeamchatCollector(async () => [row({ ts: "2026-10-20T10:00:00Z", touched: "2026-10-28T09:00:00Z" })]);
    const out = await c.collect({ cursor: null, full: false, log });
    expect(JSON.parse(out.cursor!)).toEqual({ newest: "2026-10-28T09:00:00.000Z" });
  });

  test("a row with an unparseable timestamp is skipped and logged, the rest still lands", async () => {
    const warned: string[] = [];
    const c = athenaTeamchatCollector(async () => [row({ ts: "garbage" }), row({ id: 2 })]);
    const out = await c.collect({ cursor: null, full: false, log: { ...log, warn: (m) => warned.push(m) } });
    expect(out.records.map((r) => r.sourceId)).toEqual(["turn:2"]);
    expect(warned[0]).toContain("turn:1");
  });

  describe("into the table", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "usage-tracker-athena-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("rows are billing=iu on the team key with their own cost, and a re-read changes nothing", () => {
      const db = openDb(join(dir, "usage.db"));
      const records = [row(), row({ kind: "llm", id: 7, tool: "llm:readiness", cache_read: 0, cost: 0.0004 })].map(toRecord);
      expect(upsertRecords(db, "athena-teamchat", records, { defaultWorkspace: "work" }).newRows).toBe(2);
      expect(upsertRecords(db, "athena-teamchat", records, { defaultWorkspace: "work" }).newRows).toBe(0);
      expect(
        db.query("SELECT billing, iu_key, cost_source, round(cost_usd, 4) AS cost FROM usage_record ORDER BY source_id").all(),
      ).toEqual([
        { billing: "iu", iu_key: "athena-team", cost_source: "reported", cost: 0.0004 },
        { billing: "iu", iu_key: "athena-team", cost_source: "reported", cost: 0.0123 },
      ]);
      db.close();
    });
  });
});
