import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "./db.ts";
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
