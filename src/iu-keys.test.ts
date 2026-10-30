import type { SQL } from "bun";
import { beforeEach, describe, expect, test } from "bun:test";
import { parseIuKey, resolveIuKey } from "./iu-keys.ts";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import { upsertRecords } from "./pg/writer.ts";
import { stats } from "./report.ts";
import type { UsageRecord } from "./types.ts";

function rec(sourceId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sourceId,
    grain: "message",
    ts: "2026-10-27T10:00:00.000Z",
    model: "claude-haiku-5-5",
    project: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

describe("resolveIuKey", () => {
  test("only IU-billed rows have a key; the personal key is the default", () => {
    expect(resolveIuKey({ source: "opencode", billing: "iu" })).toBe("personal");
    expect(resolveIuKey({ source: "claude-code", billing: "max" })).toBeNull();
    expect(resolveIuKey({ source: "claude-code", billing: "unknown" })).toBeNull();
  });

  test("a source's own label wins, an unregistered label never becomes a key", () => {
    expect(resolveIuKey({ source: "agent-gateway-opencode", billing: "iu", raw: { iuKey: "athena-team" } })).toBe("athena-team");
    expect(resolveIuKey({ source: "agent-gateway-opencode", billing: "iu", raw: { iuKey: "stolen" } })).toBe("personal");
    expect(resolveIuKey({ source: "agent-gateway-opencode", billing: "iu", raw: { iuKey: 7 } })).toBe("personal");
  });

  test("the teamchat source is the team key's, whatever it carries", () => {
    expect(resolveIuKey({ source: "athena-teamchat", billing: "iu" })).toBe("athena-team");
    expect(resolveIuKey({ source: "athena-teamchat", billing: "iu", raw: { iuKey: "personal" } })).toBe("personal");
  });

  test("parseIuKey accepts registered ids only", () => {
    expect(parseIuKey("athena-team")).toBe("athena-team");
    expect(parseIuKey("Athena-Team")).toBeNull();
    expect(parseIuKey(undefined)).toBeNull();
  });
});

describePg("records.api_key (Postgres)", () => {
  const pg = migratedDb();
  let sql: SQL;
  beforeEach(async () => {
    sql = await pg.reset();
  });

  test("is stored on upsert and groups in stats --by iu_key", async () => {
    await upsertRecords(sql, "opencode", [rec("a"), rec("b", { raw: { iuKey: "athena-team" } })]);
    await upsertRecords(sql, "athena-teamchat", [rec("t", { model: null, authoritativeCostUsd: 1 })]);
    const keys = await sql`SELECT source_id, api_key, billing FROM usage.records ORDER BY source_id`;
    expect(keys).toEqual([
      { source_id: "a", api_key: "personal", billing: "api_key" },
      { source_id: "b", api_key: "athena-team", billing: "api_key" },
      { source_id: "t", api_key: "athena-team", billing: "api_key" },
    ]);
    expect((await stats(sql, { by: "iu_key" })).map((r) => [r.key, r.records])).toEqual(
      expect.arrayContaining([["personal", 1], ["athena-team", 2]]),
    );
  });

  test("a label arriving on a later pass re-attributes the row", async () => {
    await upsertRecords(sql, "opencode", [rec("a")]);
    await upsertRecords(sql, "opencode", [rec("a", { raw: { iuKey: "athena-team" } })]);
    expect([...(await sql`SELECT api_key FROM usage.records`)]).toEqual([{ api_key: "athena-team" }]);
  });
});
