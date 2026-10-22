import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { agentGatewayOpencodeCollector } from "./agent-gateway-opencode.ts";

const log: Logger = { info() {}, warn() {}, error() {} };

function seed(db: Database) {
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, metadata TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
}

function addSession(db: Database, id: string, directory: string, metadata: unknown) {
  db.run("INSERT INTO session_v2 VALUES (?, ?, ?)", [id, directory, metadata ? JSON.stringify(metadata) : null]);
}

function addMessage(db: Database, id: string, session: string, seq: number, updated: number, data: unknown, type = "assistant") {
  db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [id, session, type, seq, updated - 1000, updated, JSON.stringify(data)]);
}

const assistant = (cost: number) => ({
  agent: "agw-readonly",
  model: { id: "claude-haiku-5-5-eu", providerID: "iu-anthropic" },
  cost,
  finish: "stop",
  time: { created: 1_792_657_976_504, completed: 1_792_657_978_623 },
  tokens: { input: 4, output: 325, reasoning: 120, cache: { read: 8548, write: 11553 } },
});

describe("agent-gateway-opencode collector", () => {
  let dir: string;
  let path: string;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.USAGE_AGW_OPENCODE_DB;
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-agw-opencode-"));
    path = join(dir, "opencode.db");
    process.env.USAGE_AGW_OPENCODE_DB = path;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.USAGE_AGW_OPENCODE_DB;
    else process.env.USAGE_AGW_OPENCODE_DB = original;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (cursor: string | null = null, full = false) =>
    agentGatewayOpencodeCollector.collect({ cursor, full, log });

  test("one message record per assistant message, reported cost, job id and tool kept", async () => {
    const db = new Database(path, { create: true });
    seed(db);
    addSession(db, "ses_1", "/Users/jkrumm/IuRoot/prometheus-epx", { agw: { jobId: "job-1", tool: "review:angle" } });
    addMessage(db, "msg_1", "ses_1", 1, 2000, assistant(0.0117));
    addMessage(db, "msg_u", "ses_1", 2, 2100, { text: "hi" }, "user");
    db.close();

    const { records, cursor } = await run();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({
      sourceId: "msg_1",
      grain: "message",
      model: "claude-haiku-5-5-eu",
      project: "/Users/jkrumm/IuRoot/prometheus-epx",
      workspace: "work",
      subTool: "review:angle",
      inputTokens: 4,
      outputTokens: 325,
      reasoningTokens: 120,
      cacheReadTokens: 8548,
      cacheWriteTokens: 11553,
      authoritativeCostUsd: 0.0117,
      durationMs: 2119,
    });
    expect(r.raw).toMatchObject({ jobId: "job-1", sessionId: "ses_1", providerID: "iu-anthropic" });
    expect(cursor).toBe("2000");
  });

  test("bench lanes collapse; sessions without agw metadata keep a null lane", async () => {
    const db = new Database(path, { create: true });
    seed(db);
    addSession(db, "ses_b", "/Users/jkrumm/SourceRoot/agent-gateway", { agw: { jobId: "j", tool: "bench:x:y:1:abcd" } });
    addSession(db, "ses_n", "/Users/jkrumm/SourceRoot/agent-gateway", null);
    addMessage(db, "m_b", "ses_b", 1, 2000, assistant(0.01));
    addMessage(db, "m_n", "ses_n", 1, 2000, assistant(0.01));
    db.close();

    const { records } = await run();
    const byId = Object.fromEntries(records.map((r) => [r.sourceId, r]));
    expect(byId.m_b!.subTool).toBe("bench");
    expect(byId.m_b!.workspace).toBe("private");
    expect(byId.m_n!.subTool).toBeNull();
    expect(byId.m_n!.raw?.jobId).toBeNull();
  });

  test("incremental on time_updated; the boundary instant is re-read, --full ignores the cursor", async () => {
    const db = new Database(path, { create: true });
    seed(db);
    addSession(db, "ses_1", "/x", null);
    addMessage(db, "m1", "ses_1", 1, 2000, assistant(0.01));
    addMessage(db, "m2", "ses_1", 2, 3000, assistant(0.02));
    db.close();

    expect((await run("3000")).records.map((r) => r.sourceId)).toEqual(["m2"]);
    expect((await run("3001")).records).toHaveLength(0);
    expect((await run("3000", true)).records).toHaveLength(2);
  });

  test("an unreadable store throws so ingest records an error", async () => {
    await Bun.write(path, "not a database");
    await expect(run("5")).rejects.toThrow();
  });

  test("a poison timestamp row is skipped without blocking the others", async () => {
    const db = new Database(path, { create: true });
    seed(db);
    addSession(db, "ses_1", "/x", null);
    addMessage(db, "bad", "ses_1", 1, 2000, { ...assistant(0.01), time: { created: 9e18 } });
    addMessage(db, "good", "ses_1", 2, 3000, assistant(0.02));
    db.close();
    const { records, cursor } = await run();
    expect(records.map((r) => r.sourceId)).toEqual(["good"]);
    expect(cursor).toBe("3000");
  });
});
