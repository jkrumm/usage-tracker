import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "./db.ts";
import { getSessionAccount, parseAccount, resolveAccount, resetSessionBaseUrlsCacheForTest, useSessionEnvStore } from "./models.ts";
import { relane } from "./relane.ts";
import { resyncAccount } from "./sync.ts";
import { formatBillingAudit, sessionBillingAudit, stats } from "./report.ts";
import type { UsageRecord } from "./types.ts";

// The account dimension: Max rows take the session_env line's account (absent
// = "iu"), every non-Max row is NULL, and the backfill/upsert stay idempotent.

function rec(sessionId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sourceId: crypto.randomUUID(),
    grain: "message",
    ts: new Date().toISOString(),
    model: "claude-sonnet-5",
    project: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    raw: { sessionId },
    ...overrides,
  };
}

describe("usage_record.account", () => {
  let dir: string;
  let logs: string;
  let db: Database;

  const accountOf = (sourceId: string) =>
    db
      .query<{ account: string | null; billing: string }, [string]>(
        "SELECT account, billing FROM usage_record WHERE source_id = ?",
      )
      .get(sourceId);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-account-"));
    logs = join(dir, "logs");
    Bun.spawnSync(["mkdir", "-p", logs]);
    process.env.USAGE_CLAUDE_LOGS_DIR = logs;
    db = openDb(join(dir, "usage.db"));
    useSessionEnvStore(db);
  });

  afterEach(() => {
    resetSessionBaseUrlsCacheForTest();
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeEnv = (lines: Array<Record<string, unknown>>) =>
    writeFileSync(
      join(logs, "2026-10-24.jsonl"),
      lines.map((data) => JSON.stringify({ event: "session_env", data })).join("\n") + "\n",
    );

  test("a line with account me -> me; a line without account -> iu; billing iu -> NULL", () => {
    writeEnv([
      { session: "s-b", base_url: "", lane: null, account: "me" },
      { session: "s-old", base_url: "", lane: null },
      { session: "s-iu", base_url: "https://iu.example", lane: null, account: "me" },
    ]);
    const b = rec("s-b");
    const old = rec("s-old");
    const iu = rec("s-iu");
    upsertRecords(db, "claude-code", [b, old, iu]);

    expect(accountOf(b.sourceId)).toEqual({ account: "me", billing: "max" });
    expect(accountOf(old.sourceId)).toEqual({ account: "iu", billing: "max" });
    expect(accountOf(iu.sourceId)).toEqual({ account: null, billing: "iu" });
  });

  test("account survives log pruning via the session_env table", () => {
    writeEnv([{ session: "s-b", base_url: "", lane: null, account: "me" }]);
    upsertRecords(db, "claude-code", [rec("s-b")]);
    rmSync(join(logs, "2026-10-24.jsonl"));
    resetSessionBaseUrlsCacheForTest();
    useSessionEnvStore(db);

    const later = rec("s-b");
    upsertRecords(db, "claude-code", [later]);
    expect(accountOf(later.sourceId)?.account).toBe("me");
  });

  test("no session line: max defaults to iu, a source-carried account is accepted, non-claude-code sources stay NULL", () => {
    const noLine = rec("ghost");
    const carried = rec("ghost2", { raw: { sessionId: "ghost2", account: "me" } });
    const hermes = rec("x");
    upsertRecords(db, "claude-code", [noLine, carried]);
    upsertRecords(db, "hermes", [hermes]);

    expect(accountOf(noLine.sourceId)?.account).toBe("iu");
    expect(accountOf(carried.sourceId)?.account).toBe("me");
    expect(accountOf(hermes.sourceId)).toEqual({ account: null, billing: "iu" });
  });

  test("re-upserting unchanged rows leaves ingested_at alone (delta stays a delta)", () => {
    writeEnv([{ session: "s-b", base_url: "", lane: null, account: "me" }]);
    const r = rec("s-b");
    upsertRecords(db, "claude-code", [r]);
    db.exec("UPDATE usage_record SET ingested_at = '2000-01-01 00:00:00'");
    upsertRecords(db, "claude-code", [r]);
    const row = db.query<{ ingested_at: string }, []>("SELECT ingested_at FROM usage_record").get();
    expect(row?.ingested_at).toBe("2000-01-01 00:00:00");
  });

  test("backfill: legacy max rows -> iu with synced_at untouched, iu untouched, runs once; resync-account re-queues max only", () => {
    const path = join(dir, "legacy.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE usage_record (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, grain TEXT NOT NULL,
      ts TEXT NOT NULL, model_norm TEXT, billing TEXT NOT NULL, ingested_at TEXT NOT NULL, synced_at TEXT,
      UNIQUE (source, source_id));
      CREATE TABLE session_env (session TEXT PRIMARY KEY, base_url TEXT, lane TEXT, seen_at TEXT NOT NULL);
      INSERT INTO usage_record (source, source_id, grain, ts, billing, ingested_at, synced_at) VALUES
        ('claude-code','m1','message','2026-01-01T00:00:00Z','max','2026-01-01','2026-01-02'),
        ('claude-code','i1','message','2026-01-01T00:00:00Z','iu','2026-01-01','2026-01-02');`);
    legacy.close();

    for (let i = 0; i < 2; i++) {
      const migrated = openDb(path);
      const rows = migrated
        .query<{ source_id: string; account: string | null; synced_at: string | null }, []>(
          "SELECT source_id, account, synced_at FROM usage_record ORDER BY source_id",
        )
        .all();
      expect(rows).toEqual([
        { source_id: "i1", account: null, synced_at: "2026-01-02" },
        { source_id: "m1", account: "iu", synced_at: "2026-01-02" },
      ]);
      const envCols = migrated.query<{ name: string }, []>("PRAGMA table_info(session_env)").all();
      expect(envCols.map((c) => c.name)).toContain("account");
      if (i === 1) {
        expect(resyncAccount(migrated)).toBe(1);
        const synced = migrated
          .query<{ source_id: string; synced_at: string | null }, []>(
            "SELECT source_id, synced_at FROM usage_record ORDER BY source_id",
          )
          .all();
        expect(synced).toEqual([
          { source_id: "i1", synced_at: "2026-01-02" },
          { source_id: "m1", synced_at: null },
        ]);
      }
      migrated.close();
    }
  });

  test("stats --by account and billing-audit show the split", () => {
    writeEnv([
      { session: "s-b", base_url: "", lane: null, account: "me" },
      { session: "s-a", base_url: "", lane: null },
    ]);
    upsertRecords(db, "claude-code", [rec("s-b"), rec("s-b"), rec("s-a")]);

    const byAccount = Object.fromEntries(stats(db, { by: "account" }).map((r) => [r.key, r.records]));
    expect(byAccount).toEqual({ iu: 1, me: 2 });

    const audit = sessionBillingAudit(db);
    expect(audit.find((r) => r.sessionId === "s-b")?.accounts).toBe("me");
    expect(formatBillingAudit(audit)).toContain("acct");
  });

  test("a NULL Max row written after the migration stays NULL on reopen (collector bugs stay visible)", () => {
    const r = rec("s-old");
    upsertRecords(db, "claude-code", [r]);
    db.exec("UPDATE usage_record SET account = NULL, synced_at = '2026-01-02'");
    const path = join(dir, "usage.db");
    db.close();

    db = openDb(path);
    const row = db
      .query<{ account: string | null; synced_at: string | null }, []>(
        "SELECT account, synced_at FROM usage_record",
      )
      .get();
    expect(row).toEqual({ account: null, synced_at: "2026-01-02" });
  });

  test("relane --dry-run writes nothing, session_env included", () => {
    writeEnv([{ session: "s-b", base_url: "", lane: "wave", account: "me" }]);
    const real = rec("s-b");
    upsertRecords(db, "claude-code", [real]);
    db.exec("DELETE FROM session_env");
    db.exec("UPDATE usage_record SET sub_tool = NULL");
    resetSessionBaseUrlsCacheForTest();
    useSessionEnvStore(db);

    const result = relane(db, new Map([["s-b", "cli"]]), { dryRun: true });
    expect(result.transitions.length).toBeGreaterThan(0);
    expect(db.query<{ c: number }, []>("SELECT count(*) c FROM session_env").get()?.c).toBe(0);
    expect(db.query<{ sub_tool: string | null }, []>("SELECT sub_tool FROM usage_record").get()?.sub_tool).toBeNull();
  });

  test("within the logs, a later line omitting account keeps the earlier one", () => {
    writeEnv([
      { session: "s-b", base_url: "", lane: null, account: "me" },
      { session: "s-b", base_url: "", lane: "wave" },
    ]);
    resetSessionBaseUrlsCacheForTest(); // logs only, no store
    expect(getSessionAccount("s-b")).toBe("me");
  });

  test("a later line without account keeps the stored account", () => {
    writeEnv([{ session: "s-b", base_url: "", lane: null, account: "me" }]);
    upsertRecords(db, "claude-code", [rec("s-b")]);
    writeEnv([{ session: "s-b", base_url: "", lane: null }]);
    resetSessionBaseUrlsCacheForTest();
    useSessionEnvStore(db);

    const later = rec("s-b");
    upsertRecords(db, "claude-code", [later]);
    expect(accountOf(later.sourceId)?.account).toBe("me");
    const stored = db.query<{ account: string | null }, []>("SELECT account FROM session_env").get();
    expect(stored?.account).toBe("me");
  });

  test("an unknown account value falls back to iu", () => {
    writeEnv([{ session: "s-x", base_url: "", lane: null, account: "c" }]);
    const r = rec("s-x");
    upsertRecords(db, "claude-code", [r]);
    expect(accountOf(r.sourceId)?.account).toBe("iu");
  });

  test("relane: synthetic iu row in a b session flipped to max gets me; max->iu clears it", () => {
    writeEnv([{ session: "s-b", base_url: "", lane: null, account: "me" }]);
    const real = rec("s-b");
    const synthetic = rec("s-b", { model: "<synthetic>" });
    upsertRecords(db, "claude-code", [real, synthetic]);
    // simulate the pre-fix slip: synthetic row stored as iu
    db.exec("UPDATE usage_record SET billing = 'iu', account = NULL WHERE model = '<synthetic>'");

    relane(db, new Map([["s-b", "cli"]]));
    expect(accountOf(synthetic.sourceId)).toEqual({ account: "me", billing: "max" });

    // a max row reclassified to a non-max billing (iu) must carry NULL
    db.exec("UPDATE usage_record SET sub_tool = NULL WHERE source_id = '" + real.sourceId + "'");
    db.exec("UPDATE usage_record SET billing = 'iu' WHERE source_id = '" + real.sourceId + "'");
    relane(db, new Map([["s-b", "cli"]]));
    expect(accountOf(real.sourceId)?.account).toBeNull();
  });

  test("legacy a/b ids map to iu/me for log lines, session_env rows and raw values", () => {
    writeEnv([
      { session: "s-la", base_url: "", lane: null, account: "a" },
      { session: "s-lb", base_url: "", lane: null, account: "b" },
    ]);
    expect(getSessionAccount("s-la")).toBe("iu");
    expect(getSessionAccount("s-lb")).toBe("me");
    const carried = rec("ghost", { raw: { sessionId: "ghost", account: "b" } });
    upsertRecords(db, "claude-code", [carried]);
    expect(accountOf(carried.sourceId)?.account).toBe("me");
    expect(parseAccount("iu")).toBe("iu");
    expect(parseAccount("me")).toBe("me");
    expect(parseAccount("x")).toBeNull();
  });

  test("migration renames legacy a/b in usage_record and session_env, idempotently, synced_at untouched", () => {
    const path = join(dir, "legacy-ab.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE usage_record (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, grain TEXT NOT NULL,
      ts TEXT NOT NULL, model_norm TEXT, billing TEXT NOT NULL, account TEXT, ingested_at TEXT NOT NULL,
      synced_at TEXT, UNIQUE (source, source_id));
      CREATE TABLE session_env (session TEXT PRIMARY KEY, base_url TEXT, lane TEXT, account TEXT, seen_at TEXT NOT NULL);
      INSERT INTO usage_record (source, source_id, grain, ts, billing, account, ingested_at, synced_at) VALUES
        ('claude-code','m-a','message','2026-01-01T00:00:00Z','max','a','2026-01-01','2026-01-02'),
        ('claude-code','m-b','message','2026-01-01T00:00:00Z','max','b','2026-01-01','2026-01-02'),
        ('claude-code','i1','message','2026-01-01T00:00:00Z','iu',NULL,'2026-01-01','2026-01-02');
      INSERT INTO session_env (session, base_url, lane, account, seen_at) VALUES
        ('s1','',NULL,'a','2026-01-01'), ('s2','',NULL,'b','2026-01-01');`);
    legacy.close();

    for (let i = 0; i < 2; i++) {
      const migrated = openDb(path);
      expect(
        migrated
          .query<{ source_id: string; account: string | null; synced_at: string | null }, []>(
            "SELECT source_id, account, synced_at FROM usage_record ORDER BY source_id",
          )
          .all(),
      ).toEqual([
        { source_id: "i1", account: null, synced_at: "2026-01-02" },
        { source_id: "m-a", account: "iu", synced_at: "2026-01-02" },
        { source_id: "m-b", account: "me", synced_at: "2026-01-02" },
      ]);
      expect(
        migrated.query<{ account: string }, []>("SELECT account FROM session_env ORDER BY session").all(),
      ).toEqual([{ account: "iu" }, { account: "me" }]);
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
      migrated.close();
    }
  });

  test("resolveAccount: line account wins (legacy ids mapped); unknown/empty/non-string falls through", () => {
    const lookup = (id: string) => (id === "s" ? "me" : undefined);
    const resolve = (account: unknown) =>
      resolveAccount({ billing: "max", raw: { sessionId: "s", account } }, lookup);

    expect(resolve("iu")).toBe("iu");
    expect(resolve("a")).toBe("iu");
    expect(resolve("b")).toBe("me");
    for (const bad of ["x", "", 5, null, {}]) expect(resolve(bad)).toBe("me");
    expect(resolveAccount({ billing: "max", raw: { sessionId: "other", account: "x" } }, lookup)).toBe("iu");
    expect(resolveAccount({ billing: "iu", raw: { account: "me" } }, lookup)).toBeNull();
  });
});
