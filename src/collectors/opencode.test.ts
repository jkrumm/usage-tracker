import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { opencodeCollector } from "./opencode.ts";

// Exercises the collector against a real sqlite file shaped like the live
// opencode.db schema (session + message, message.data a JSON blob) rather
// than mocking bun:sqlite — the message-grain read, the path.cwd/directory
// fallback and the legacy session-grain fallback are the whole point.

const log: Logger = { info() {}, warn() {}, error() {} };
let originalDbPath: string | undefined;

function messageData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role: "assistant",
    agent: "build",
    mode: "build",
    path: { cwd: "/Users/jkrumm/SourceRoot/agentsmd-poc", root: "/Users/jkrumm/SourceRoot/agentsmd-poc" },
    cost: 0.000103878,
    tokens: { total: 21635, input: 257, output: 2, reasoning: 0, cache: { write: 0, read: 21376 } },
    modelID: "deepseek-v4.1-flash",
    providerID: "iu",
    time: { created: 1_790_275_376_743, completed: 1_790_275_377_961 },
    finish: "stop",
    ...overrides,
  });
}

describe("opencode collector", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    originalDbPath = process.env.USAGE_OPENCODE_DB;
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-opencode-"));
    dbPath = join(dir, "opencode.db");
    process.env.USAGE_OPENCODE_DB = dbPath;
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.USAGE_OPENCODE_DB;
    else process.env.USAGE_OPENCODE_DB = originalDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test("prefers message grain: one record per assistant message, project from path.cwd", async () => {
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, slug TEXT, title TEXT, agent TEXT, model TEXT,
        cost REAL DEFAULT 0, time_created INTEGER NOT NULL,
        tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
        tokens_cache_write INTEGER DEFAULT 0
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
    db.run(
      "INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)",
      ["ses-1", "/Users/jkrumm/SourceRoot/agentsmd-poc", 1_790_275_000_000],
    );
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["msg-user", "ses-1", 1_790_275_376_000, 1_790_275_376_000, JSON.stringify({ role: "user" })],
    );
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["msg-1", "ses-1", 1_790_275_376_743, 1_790_275_377_961, messageData()],
    );
    db.close();

    const { records } = await opencodeCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1); // user-role message excluded
    const r = records[0]!;
    expect(r.sourceId).toBe("msg-1");
    expect(r.grain).toBe("message");
    expect(r.model).toBe("deepseek-v4.1-flash");
    expect(r.project).toBe("/Users/jkrumm/SourceRoot/agentsmd-poc");
    expect(r.inputTokens).toBe(257);
    expect(r.outputTokens).toBe(2);
    expect(r.cacheReadTokens).toBe(21376);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.reasoningTokens).toBe(0);
    expect(r.durationMs).toBe(1_790_275_377_961 - 1_790_275_376_743);
    expect(r.raw?.providerID).toBe("iu");
  });

  test("falls back to the session's directory when a message carries no path", async () => {
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
    db.run("INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)", [
      "ses-2",
      "/Users/jkrumm/SourceRoot/warden",
      1_790_275_000_000,
    ]);
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["msg-2", "ses-2", 1_790_275_400_000, 1_790_275_401_000, messageData({ path: undefined })],
    );
    db.close();

    const { records } = await opencodeCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    expect(records[0]?.project).toBe("/Users/jkrumm/SourceRoot/warden");
  });

  test("falls back to session grain when the message table doesn't exist", async () => {
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, slug TEXT, title TEXT, agent TEXT, model TEXT,
        cost REAL DEFAULT 0, time_created INTEGER NOT NULL,
        tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
        tokens_cache_write INTEGER DEFAULT 0
      );
    `);
    db.run(
      `INSERT INTO session (id, directory, model, time_created, tokens_input, tokens_output)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["ses-3", "/Users/jkrumm/SourceRoot/legacy", '{"id":"kimi-k2.6","providerID":"iu"}', 1_790_275_000_000, 100, 50],
    );
    db.close();

    const { records } = await opencodeCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    expect(records[0]?.sourceId).toBe("ses-3");
    expect(records[0]?.grain).toBe("session");
    expect(records[0]?.inputTokens).toBe(100);
  });
});
