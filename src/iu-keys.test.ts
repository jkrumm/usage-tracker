import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "./db.ts";
import { parseIuKey, resolveIuKey } from "./iu-keys.ts";
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

describe("usage_record.iu_key", () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-iukey-"));
    db = openDb(join(dir, "usage.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("is stored on upsert and groups in stats", () => {
    upsertRecords(db, "opencode", [rec("a"), rec("b", { raw: { iuKey: "athena-team" } })]);
    upsertRecords(db, "athena-teamchat", [rec("t", { model: null, authoritativeCostUsd: 1 })]);
    const keys = db
      .query<{ source_id: string; iu_key: string | null }, []>("SELECT source_id, iu_key FROM usage_record ORDER BY source_id")
      .all();
    expect(keys).toEqual([
      { source_id: "a", iu_key: "personal" },
      { source_id: "b", iu_key: "athena-team" },
      { source_id: "t", iu_key: "athena-team" },
    ]);
    expect(stats(db, { by: "iu_key" }).map((r) => [r.key, r.records])).toEqual(expect.arrayContaining([["personal", 1], ["athena-team", 2]]));
  });

  test("a label arriving on a later pass re-attributes the row", () => {
    upsertRecords(db, "opencode", [rec("a")]);
    upsertRecords(db, "opencode", [rec("a", { raw: { iuKey: "athena-team" } })]);
    expect(db.query("SELECT iu_key FROM usage_record").all()).toEqual([{ iu_key: "athena-team" }]);
  });
});

describe("syncing keyed rows to Argo", () => {
  test("non-personal rows stay queued until USAGE_SYNC_IU_KEYS=1", async () => {
    const { sync } = await import("./sync.ts");
    const dir = mkdtempSync(join(tmpdir(), "usage-tracker-iukey-sync-"));
    const db = openDb(join(dir, "usage.db"));
    const bodies: Array<{ records: Array<{ source_id: string; iu_key: string | null }> }> = [];
    const realFetch = globalThis.fetch;
    process.env.ARGO_TOKEN = "t";
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      upsertRecords(db, "opencode", [rec("p1")]);
      upsertRecords(db, "athena-teamchat", [rec("t1", { model: null, authoritativeCostUsd: 1 })]);
      await sync(db);
      expect(bodies.flatMap((b) => b.records ?? []).map((r) => [r.source_id, r.iu_key])).toEqual([["p1", "personal"]]);
      process.env.USAGE_SYNC_IU_KEYS = "1";
      await sync(db);
      expect(bodies.flatMap((b) => b.records ?? []).map((r) => [r.source_id, r.iu_key])).toEqual([["p1", "personal"], ["t1", "athena-team"]]);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ARGO_TOKEN;
      delete process.env.USAGE_SYNC_IU_KEYS;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("iu_key migration", () => {
  test("backfills IU rows as personal and rebuilds the portal tables per key, idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-tracker-iukey-mig-"));
    const path = join(dir, "legacy.db");
    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`CREATE TABLE usage_record (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, grain TEXT NOT NULL,
        ts TEXT NOT NULL, model_norm TEXT, billing TEXT NOT NULL, account TEXT, ingested_at TEXT NOT NULL,
        synced_at TEXT, UNIQUE (source, source_id));
        CREATE TABLE iu_portal_cost (day TEXT NOT NULL, label TEXT NOT NULL, row INTEGER NOT NULL, model TEXT,
          cost_usd REAL NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (day, label, row));
        CREATE TABLE iu_portal_total (month TEXT PRIMARY KEY, total_usd REAL NOT NULL, fetched_at INTEGER NOT NULL);
        INSERT INTO usage_record (source, source_id, grain, ts, billing, ingested_at, synced_at) VALUES
          ('opencode','i1','message','2026-01-01T00:00:00Z','iu','2026-01-01','2026-01-02'),
          ('claude-code','m1','message','2026-01-01T00:00:00Z','max','2026-01-01','2026-01-02');
        INSERT INTO iu_portal_cost VALUES ('2026-10-01','Haiku',1,'claude-haiku-5-5',2.5,1000);
        INSERT INTO iu_portal_total VALUES ('2026-10',2.5,1000);
        PRAGMA user_version = 2;`);
      legacy.close();

      for (let i = 0; i < 2; i++) {
        const db = openDb(path);
        expect(
          db.query<{ source_id: string; iu_key: string | null; synced_at: string | null }, []>(
            "SELECT source_id, iu_key, synced_at FROM usage_record ORDER BY source_id",
          ).all(),
        ).toEqual([
          { source_id: "i1", iu_key: "personal", synced_at: "2026-01-02" },
          { source_id: "m1", iu_key: null, synced_at: "2026-01-02" },
        ]);
        expect(db.query("SELECT iu_key, day, cost_usd FROM iu_portal_cost").all()).toEqual([
          { iu_key: "personal", day: "2026-10-01", cost_usd: 2.5 },
        ]);
        expect(db.query("SELECT iu_key, month, total_usd FROM iu_portal_total").all()).toEqual([
          { iu_key: "personal", month: "2026-10", total_usd: 2.5 },
        ]);
        // The same day may now exist once per key.
        db.run("INSERT INTO iu_portal_cost (iu_key, day, label, row, cost_usd, fetched_at) VALUES ('athena-team','2026-10-01','Haiku',1,9,1)");
        db.run("DELETE FROM iu_portal_cost WHERE iu_key = 'athena-team'");
        expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
