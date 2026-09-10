import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iumacLogsDir, iumacProjectsDir } from "../remote.ts";
import type { Logger } from "../types.ts";
import { claudeCodeCollector, setSyncOverrideForTest } from "./claude-code.ts";

// Integration coverage for the two-root walk: collectRoot() sharing one
// Offsets map across hosts, per-record machine attribution, and the
// note/advanceOffsets behavior around a failed mirror sync — all exercised
// through tmp dirs standing in for the real ~/.claude/projects and the iumac
// mirror. setSyncOverrideForTest lets the failure-path tests force syncIumac's
// outcome without ever spawning ssh or rsync.

const log: Logger = { info() {}, warn() {}, error() {} };

function assistantLine(requestId: string): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    message: {
      id: `msg-${requestId}`,
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  })}\n`;
}

describe("claude-code two-root collector", () => {
  let localDir: string;
  let remoteDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-"));
    remoteDir = mkdtempSync(join(tmpdir(), "usage-tracker-remote-"));
    process.env.USAGE_CLAUDE_PROJECTS_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = remoteDir;
    process.env.USAGE_IUMAC_MACHINE = "MacBook Pro (Test)";
  });

  afterEach(() => {
    setSyncOverrideForTest(null);
    delete process.env.USAGE_CLAUDE_PROJECTS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    delete process.env.USAGE_IUMAC_MACHINE;
    rmSync(localDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  test("offsets for local and mirror files coexist without colliding; mirror carries machine, local leaves it null", async () => {
    const localFile = join(localDir, "local-session.jsonl");
    writeFileSync(localFile, assistantLine("local-req"));

    const mirrorProjectsDir = iumacProjectsDir();
    mkdirSync(mirrorProjectsDir, { recursive: true });
    const mirrorFile = join(mirrorProjectsDir, "mirror-session.jsonl");
    writeFileSync(mirrorFile, assistantLine("mirror-req"));

    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const localRecord = result.records.find((r) => r.sourceId === "local-req");
    const mirrorRecord = result.records.find((r) => r.sourceId === "mirror-req");
    expect(localRecord?.machine).toBeNull();
    expect(mirrorRecord?.machine).toBe("MacBook Pro (Test)");

    const offsets = JSON.parse(result.cursor ?? "{}") as Record<string, number>;
    expect(offsets[localFile]).toBeGreaterThan(0);
    expect(offsets[mirrorFile]).toBeGreaterThan(0);
    expect(offsets[localFile]).not.toBe(offsets[mirrorFile]);
  });

  test("a failed sync still reports the local root's records with the note surfaced", async () => {
    writeFileSync(join(localDir, "local-session.jsonl"), assistantLine("local-req"));
    setSyncOverrideForTest(async () => ({
      ok: false,
      note: "iumac projects rsync exit 1",
      logsOk: false,
      codexOk: true,
      usageJsonlOk: true,
    }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    // Per ingest.ts:69, a note only demotes a run to `skipped` when records is
    // also empty — records.length > 0 here means the run reports `ok`. This
    // pins the exact behaviour that used to be wrong: the note used to be
    // swallowed whenever any local record came in.
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.note).toBe("iumac projects rsync exit 1");
  });

  test("advanceOffsets: false emits mirror records without advancing the mirror offset (no logs mirror at all)", async () => {
    const mirrorProjectsDir = iumacProjectsDir();
    mkdirSync(mirrorProjectsDir, { recursive: true });
    const mirrorFile = join(mirrorProjectsDir, "mirror-session.jsonl");
    writeFileSync(mirrorFile, assistantLine("mirror-req"));
    // Deliberately no iumacLogsDir() at all — hasMirroredLogs() is false, so a
    // failed logs leg must withhold the mirror offset.

    setSyncOverrideForTest(async () => ({
      ok: false,
      note: "iumac logs rsync exit 1",
      logsOk: false,
      codexOk: true,
      usageJsonlOk: true,
    }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const mirrorRecord = result.records.find((r) => r.sourceId === "mirror-req");
    expect(mirrorRecord).toBeDefined();

    const offsets = JSON.parse(result.cursor ?? "{}") as Record<string, number>;
    expect(offsets[mirrorFile]).toBeUndefined();
  });

  test("a failed logs leg with an existing logs mirror still advances offsets (bounded staleness)", async () => {
    const mirrorProjectsDir = iumacProjectsDir();
    mkdirSync(mirrorProjectsDir, { recursive: true });
    const mirrorFile = join(mirrorProjectsDir, "mirror-session.jsonl");
    writeFileSync(mirrorFile, assistantLine("mirror-req"));

    const logsDir = iumacLogsDir();
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "2026-08-06.jsonl"),
      `${JSON.stringify({ event: "session_env", data: { session: "s", base_url: null } })}\n`,
    );

    setSyncOverrideForTest(async () => ({
      ok: false,
      note: "iumac projects rsync exit 1",
      logsOk: false,
      codexOk: true,
      usageJsonlOk: true,
    }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const offsets = JSON.parse(result.cursor ?? "{}") as Record<string, number>;
    expect(offsets[mirrorFile]).toBeGreaterThan(0);
  });
});
