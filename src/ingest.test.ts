import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { runIngest } from "./ingest.ts";
import { astraCollector } from "./collectors/astra.ts";
import { claudeCodeCollector } from "./collectors/claude-code.ts";
import { codexCollector } from "./collectors/codex.ts";
import type { SyncResult } from "./remote.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const ENV_KEYS = [
  "USAGE_DB",
  "USAGE_CLAUDE_PROJECTS_DIR",
  "USAGE_CLAUDE_LOGS_DIR",
  "USAGE_CODEX_SESSIONS_DIR",
  "USAGE_ASTRA_DIR",
  "USAGE_REMOTE_DIR",
  "ARGO_TOKEN",
] as const;

const ok: SyncResult = { ok: true, logsOk: true, codexOk: true, usageJsonlOk: true };

describe("runIngest iumac mirror sync", () => {
  let dir: string;
  let db: Database;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-ingest-"));
    mkdirSync(join(dir, "claude-projects"));
    mkdirSync(join(dir, "codex-sessions"));
    writeFileSync(join(dir, "astra.jsonl"), "");
    process.env.USAGE_DB = join(dir, "usage.db");
    process.env.USAGE_CLAUDE_PROJECTS_DIR = join(dir, "claude-projects");
    process.env.USAGE_CLAUDE_LOGS_DIR = join(dir, "claude-logs");
    process.env.USAGE_CODEX_SESSIONS_DIR = join(dir, "codex-sessions");
    process.env.USAGE_ASTRA_DIR = dir;
    process.env.USAGE_REMOTE_DIR = join(dir, "remote");
    delete process.env.ARGO_TOKEN;
    db = openDb(join(dir, "usage.db"));
  });

  afterEach(() => {
    db.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("syncs the mirror once per pass, and again on the next pass", async () => {
    let calls = 0;
    const opts = {
      collectors: [claudeCodeCollector, codexCollector, astraCollector],
      syncIumac: async () => {
        calls++;
        return ok;
      },
    };

    const first = await runIngest(db, opts);
    expect(first.results.map((r) => r.source)).toEqual(["claude-code", "codex", "astra"]);
    expect(first.results.every((r) => r.status !== "skipped")).toBe(true);
    expect(calls).toBe(1);

    await runIngest(db, opts);
    expect(calls).toBe(2);
  });
});
