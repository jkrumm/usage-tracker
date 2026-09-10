import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { modelpickCollector } from "./modelpick.ts";

// Pins the token-field mapping (cache_creation_tokens -> cacheWriteTokens,
// thinking_tokens -> reasoningTokens), the harness's own cost surviving only
// in raw.bench_cost_usd, the capability_probe table never being touched, and
// the id-watermark advancing across two collect() calls.

const log: Logger = { info() {}, warn() {}, error() {} };

function createDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE bench_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suite_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt INTEGER DEFAULT 1 NOT NULL,
      duration_ms INTEGER NOT NULL,
      api_duration_ms INTEGER,
      num_turns INTEGER NOT NULL,
      input_tokens INTEGER DEFAULT 0 NOT NULL,
      output_tokens INTEGER DEFAULT 0 NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0 NOT NULL,
      cache_creation_tokens INTEGER DEFAULT 0 NOT NULL,
      thinking_tokens INTEGER DEFAULT 0 NOT NULL,
      cost_usd REAL,
      terminal_reason TEXT,
      created_at TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL
    );
    -- No token columns at all — the collector must never read this table.
    CREATE TABLE capability_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      latency_ms INTEGER,
      accessible INTEGER,
      probe_status TEXT,
      residency TEXT
    );
  `);
  return db;
}

describe("modelpick collector", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-modelpick-"));
    dbFile = join(dir, "modelpick.db");
    process.env.MODELPICK_DB = dbFile;
  });

  afterEach(() => {
    delete process.env.MODELPICK_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps tokens, keeps the harness's own cost only as raw.bench_cost_usd, and ignores capability_probe", async () => {
    const db = createDb(dbFile);
    db.run(
      `INSERT INTO bench_run
        (suite_id, model_id, task_id, attempt, duration_ms, num_turns, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, thinking_tokens, cost_usd, terminal_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["r1", "claude-sonnet-5", "fix-failing-test", 1, 41230, 6, 1234, 567, 100, 50, 890, 0.1014, "stop", "2026-08-31 08:12:01"],
    );
    db.run(
      `INSERT INTO capability_probe (model_id, latency_ms, accessible, probe_status, residency)
       VALUES (?, ?, ?, ?, ?)`,
      ["claude-sonnet-5", 120, 1, "ok", "eu"],
    );
    db.close();

    const { records, cursor } = await modelpickCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sourceId).toBe("1");
    expect(r.grain).toBe("session");
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.project).toBe("modelpick");
    expect(r.subTool).toBe("r1");
    expect(r.inputTokens).toBe(1234);
    expect(r.outputTokens).toBe(567);
    expect(r.cacheReadTokens).toBe(100);
    expect(r.cacheWriteTokens).toBe(50); // cache_creation_tokens
    expect(r.reasoningTokens).toBe(890); // thinking_tokens
    expect(r.durationMs).toBe(41230);
    expect(r.raw?.bench_cost_usd).toBe(0.1014);
    expect(r.ts).toBe("2026-08-31T08:12:01.000Z");
    expect(cursor).toBe("1");
  });

  test("advances the id watermark so a second run only picks up new rows", async () => {
    const db = createDb(dbFile);
    db.run(
      `INSERT INTO bench_run (suite_id, model_id, task_id, duration_ms, num_turns, input_tokens, output_tokens)
       VALUES ('r1', 'claude-sonnet-5', 'task-a', 1000, 1, 10, 5)`,
    );
    db.close();

    const first = await modelpickCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId)).toEqual(["1"]);

    const db2 = new Database(dbFile);
    db2.run(
      `INSERT INTO bench_run (suite_id, model_id, task_id, duration_ms, num_turns, input_tokens, output_tokens)
       VALUES ('r1', 'claude-sonnet-5', 'task-b', 2000, 1, 20, 8)`,
    );
    db2.close();

    const second = await modelpickCollector.collect({ cursor: first.cursor, full: false, log });
    expect(second.records.map((r) => r.sourceId)).toEqual(["2"]);
  });

  test("available() is false when the DB is absent, without throwing", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(modelpickCollector.available()).toBe(false);
  });
});
