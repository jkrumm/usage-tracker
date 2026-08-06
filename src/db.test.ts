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
