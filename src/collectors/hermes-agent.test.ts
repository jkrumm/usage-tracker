import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { hermesAgentCollector } from "./hermes-agent.ts";

// Exercises the collector against a real sqlite file (built with bun:sqlite,
// read back out-of-process via the system `sqlite3` CLI exactly like
// production) rather than mocking the subprocess — the composite sourceId and
// the subTool namespacing are the whole point of the session_model_usage
// re-key, so they need to survive the real join, not a stub of it.

const log: Logger = { info() {}, warn() {}, error() {} };

describe("hermes-agent collector — session_model_usage", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-hermes-"));
    dbPath = join(dir, "state.db");
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT,
        model TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        end_reason TEXT,
        message_count INTEGER,
        tool_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        billing_provider TEXT NOT NULL DEFAULT '',
        billing_base_url TEXT NOT NULL DEFAULT '',
        billing_mode TEXT NOT NULL DEFAULT '',
        task TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        actual_cost_usd REAL NOT NULL DEFAULT 0,
        cost_status TEXT,
        PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
      );
    `);
    db.run(
      "INSERT INTO sessions (id, source, model, started_at, ended_at, end_reason, message_count, tool_call_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["sess-1", "cron", "claude-sonnet-5", 1_757_000_000, 1_757_000_100, "stop", 3, 2],
    );
    // Main agent loop row — empty task.
    db.run(
      "INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["sess-1", "claude-sonnet-5", "", 100, 50, 10, 5, 0],
    );
    // Side task on a different model — this row was invisible under the old
    // `sessions`-table read.
    db.run(
      "INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["sess-1", "claude-haiku-5", "background_review", 200, 80, 0, 0, 0],
    );
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("keys each (session, task, model) row uniquely and namespaces subTool with the channel", async () => {
    const collector = hermesAgentCollector({
      source: "hermes",
      dbPath,
      workspace: "private",
      project: "hermes-agent",
    });

    const { records } = await collector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(2);

    const main = records.find((r) => r.sourceId === "sess-1:main:claude-sonnet-5");
    const review = records.find((r) => r.sourceId === "sess-1:background_review:claude-haiku-5");

    expect(main).toBeDefined();
    expect(main?.model).toBe("claude-sonnet-5");
    expect(main?.subTool).toBe("cron"); // main loop: channel alone, unchanged from before the re-key
    expect(main?.inputTokens).toBe(100);
    expect(main?.grain).toBe("session");

    expect(review).toBeDefined();
    expect(review?.model).toBe("claude-haiku-5");
    expect(review?.subTool).toBe("cron:background_review"); // side task: channel:task
    expect(review?.inputTokens).toBe(200);
  });

  test("splits reasoning_tokens out of output_tokens instead of billing it twice", async () => {
    // Hermes nests reasoning inside output_tokens (OpenAI/codex convention),
    // not additive like Anthropic — passing output_tokens through unsplit
    // double-bills reasoning once as output and once as reasoning downstream.
    const dir2 = mkdtempSync(join(tmpdir(), "usage-tracker-hermes-reasoning-"));
    const dbPath2 = join(dir2, "state.db");
    const db = new Database(dbPath2, { create: true });
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL NOT NULL,
        ended_at REAL, end_reason TEXT, message_count INTEGER, tool_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT NOT NULL, model TEXT NOT NULL,
        billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
        billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
        cost_status TEXT,
        PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
      );
    `);
    db.run(
      "INSERT INTO sessions (id, source, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
      ["sess-2", "cli", "gpt-5.6-luna", 1_757_000_000, 1_757_000_100],
    );
    db.run(
      "INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?)",
      ["sess-2", "gpt-5.6-luna", "", 100, 500, 300],
    );
    db.close();

    const collector = hermesAgentCollector({
      source: "hermes",
      dbPath: dbPath2,
      workspace: "private",
      project: "hermes-agent",
    });
    const { records } = await collector.collect({ cursor: null, full: false, log });
    const r = records.find((x) => x.sourceId === "sess-2:main:gpt-5.6-luna");

    expect(r).toBeDefined();
    expect(r?.reasoningTokens).toBe(300);
    expect(r?.outputTokens).toBe(200); // 500 - 300, not the raw 500
    rmSync(dir2, { recursive: true, force: true });
  });
});
