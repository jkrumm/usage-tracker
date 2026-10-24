import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "./db.ts";
import { resetSessionBaseUrlsCacheForTest, useSessionEnvStore } from "./models.ts";
import type { UsageRecord } from "./types.ts";

// upsertRecords' machine precedence (r.machine ?? batchMachine) is the one
// piece of logic that makes the claude-code collector's two-host span work:
// a record with an explicit machine (the iumac mirror) must win, and a
// record without one must fall through to currentMachine(). Pinned against a
// real tmp-file DB rather than reasoned about by eye.

process.env.USAGE_MACHINE = "Test Machine (Override)";

function baseRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
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
    ...overrides,
  };
}

describe("upsertRecords machine precedence", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-db-test-"));
    db = openDb(join(dir, "usage.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an explicit record.machine is stored verbatim; an unset one falls back to currentMachine()", () => {
    const explicit = baseRecord({ machine: "MacBook Pro (M2 Max)" });
    const unset = baseRecord();

    upsertRecords(db, "claude-code", [explicit, unset]);

    const rows = db
      .query<
        { source_id: string; machine: string | null },
        [string]
      >("SELECT source_id, machine FROM usage_record WHERE source = ?")
      .all("claude-code");

    const explicitRow = rows.find((r) => r.source_id === explicit.sourceId);
    const unsetRow = rows.find((r) => r.source_id === unset.sourceId);

    expect(explicitRow?.machine).toBe("MacBook Pro (M2 Max)");
    expect(unsetRow?.machine).toBe("Test Machine (Override)");
  });
});

// The conflict branch of UPSERT_SQL is guarded by a row-value `IS NOT` so an
// unchanged re-ingest leaves `ingested_at` alone — otherwise every hermes/feuer
// run (a full re-read of their `sessions` table) re-pushed the whole table to
// Argo. Pinned with a back-dated ingested_at: datetime('now') is second-grained,
// so "did it move" is only observable against a stamp that can't collide.

describe("upsertRecords ingested_at", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-db-test-"));
    db = openDb(join(dir, "usage.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function ingestedAt(sourceId: string): string | undefined {
    return db
      .query<{ ingested_at: string }, [string]>(
        "SELECT ingested_at FROM usage_record WHERE source = 'hermes' AND source_id = ?",
      )
      .get(sourceId)?.ingested_at;
  }

  test("an identical re-ingest keeps ingested_at; a changed row bumps it", () => {
    const record = baseRecord({ project: null, raw: { endReason: "done" } });
    upsertRecords(db, "hermes", [record]);
    db.exec("UPDATE usage_record SET ingested_at = '2000-01-01 00:00:00'");

    upsertRecords(db, "hermes", [record]);
    expect(ingestedAt(record.sourceId)).toBe("2000-01-01 00:00:00");

    upsertRecords(db, "hermes", [{ ...record, outputTokens: record.outputTokens + 1 }]);
    expect(ingestedAt(record.sourceId)).not.toBe("2000-01-01 00:00:00");
  });
});

describe("agent-gateway-sessions account attribution", () => {
  let dir: string;
  let path: string;
  let db: Database;

  const session = (id: string, overrides: Partial<UsageRecord> = {}) =>
    baseRecord({
      sourceId: id,
      grain: "session",
      raw: { sessionId: id, backend: "max" },
      ...overrides,
    });
  const rows = () =>
    db
      .query<{ source_id: string; account: string | null; synced_at: string | null }, []>(
        "SELECT source_id, account, synced_at FROM usage_record ORDER BY source_id",
      )
      .all();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-sessions-account-"));
    Bun.spawnSync(["mkdir", "-p", join(dir, "logs")]);
    process.env.USAGE_CLAUDE_LOGS_DIR = join(dir, "logs");
    path = join(dir, "usage.db");
    db = openDb(path);
    useSessionEnvStore(db);
  });

  afterEach(() => {
    resetSessionBaseUrlsCacheForTest();
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("me session -> me, no session_env -> iu, iu backend -> NULL, line-level account wins", () => {
    writeFileSync(
      join(dir, "logs", "2026-10-24.jsonl"),
      [
        { session: "s-me", base_url: "", lane: null, account: "me" },
        { session: "s-line", base_url: "", lane: null, account: "me" },
      ]
        .map((data) => JSON.stringify({ event: "session_env", data }))
        .join("\n") + "\n",
    );
    upsertRecords(db, "agent-gateway-sessions", [
      session("s-me"),
      session("s-none"),
      session("s-iu", { raw: { sessionId: "s-iu", backend: "iu" } }),
      session("s-line", { raw: { sessionId: "s-line", backend: "max", account: "iu" } }),
    ]);

    expect(Object.fromEntries(rows().map((r) => [r.source_id, r.account]))).toEqual({
      "s-me": "me",
      "s-none": "iu",
      "s-iu": null,
      "s-line": "iu",
    });
  });

  test("a NULL Max row written after the migration stays NULL on reopen", () => {
    upsertRecords(db, "agent-gateway-sessions", [session("s-1")]);
    db.exec("UPDATE usage_record SET account = NULL");
    db.close();

    db = openDb(path);
    expect(rows()).toEqual([{ source_id: "s-1", account: null, synced_at: null }]);
  });

  test("migration re-attributes mismatching agent-gateway-sessions rows and re-queues only those", () => {
    upsertRecords(db, "agent-gateway-sessions", [session("s-wrong"), session("s-ok"), session("s-noenv")]);
    db.exec(`INSERT INTO session_env (session, base_url, lane, account, seen_at) VALUES
      ('s-wrong','',NULL,'me','2026-10-24'), ('s-ok','',NULL,'iu','2026-10-24')`);
    db.exec("UPDATE usage_record SET account = 'iu', synced_at = '2026-10-24'");
    db.exec("PRAGMA user_version = 1");
    db.close();

    db = openDb(path);
    expect(rows()).toEqual([
      { source_id: "s-noenv", account: "iu", synced_at: "2026-10-24" },
      { source_id: "s-ok", account: "iu", synced_at: "2026-10-24" },
      { source_id: "s-wrong", account: "me", synced_at: null },
    ]);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  });
});
