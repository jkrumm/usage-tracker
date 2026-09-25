import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSessionBaseUrlsCacheForTest, resetSideclawWindowsCacheForTest } from "../models.ts";
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
  let localLogsDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-local-"));
    remoteDir = mkdtempSync(join(tmpdir(), "usage-tracker-remote-"));
    localLogsDir = mkdtempSync(join(tmpdir(), "usage-tracker-logs-"));
    process.env.USAGE_CLAUDE_PROJECTS_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = remoteDir;
    process.env.USAGE_IUMAC_MACHINE = "MacBook Pro (Test)";
    // getSessionLane() now runs on every parsed line — point it at an empty
    // tmp dir rather than the real ~/.claude/logs so these tests never read
    // this machine's actual session history.
    process.env.USAGE_CLAUDE_LOGS_DIR = localLogsDir;
    // Same reasoning for the sideclaw-attribution fallback getSideclawLane()
    // now runs on every unattributed line — point it at a path that doesn't
    // exist so these tests never read this machine's real
    // sideclaw-sessions.jsonl.
    process.env.SIDECLAW_SESSIONS_LOG = join(localLogsDir, "no-such-sideclaw-sessions.jsonl");
    resetSessionBaseUrlsCacheForTest();
    resetSideclawWindowsCacheForTest();
  });

  afterEach(() => {
    setSyncOverrideForTest(null);
    delete process.env.USAGE_CLAUDE_PROJECTS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    delete process.env.USAGE_IUMAC_MACHINE;
    delete process.env.USAGE_CLAUDE_LOGS_DIR;
    delete process.env.SIDECLAW_SESSIONS_LOG;
    rmSync(localDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(localLogsDir, { recursive: true, force: true });
    resetSessionBaseUrlsCacheForTest();
    resetSideclawWindowsCacheForTest();
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

  test("a session_env line with a lane stamps sub_tool on that session's rows", async () => {
    writeFileSync(join(localDir, "local-session.jsonl"), assistantLine("local-req"));
    writeFileSync(
      join(localLogsDir, "2026-09-10.jsonl"),
      `${JSON.stringify({
        event: "session_env",
        data: { session: "session-1", base_url: null, lane: "sideclaw:review" },
      })}\n`,
    );

    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "local-req");
    expect(record?.subTool).toBe("sideclaw:review");
  });

  test("a session_env line without a lane leaves sub_tool null", async () => {
    writeFileSync(join(localDir, "local-session.jsonl"), assistantLine("local-req"));
    writeFileSync(
      join(localLogsDir, "2026-09-10.jsonl"),
      `${JSON.stringify({ event: "session_env", data: { session: "session-1", base_url: null } })}\n`,
    );

    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "local-req");
    expect(record?.subTool).toBeFalsy();
  });

  test("no session_env line at all falls back to the sideclaw-sessions.jsonl time-window join", async () => {
    const line = `${JSON.stringify({
      type: "assistant",
      requestId: "worker-req",
      sessionId: "session-1",
      timestamp: "2026-09-24T18:22:30.000Z",
      cwd: "/Users/jkrumm/SourceRoot/sideclaw",
      message: {
        id: "msg-worker-req",
        model: "deepseek-flash",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), line);
    // No session_env line for session-1 at all (pruned, or older than the
    // hook) — getSessionLane returns undefined, the only case the fallback
    // should engage for.
    writeFileSync(
      process.env.SIDECLAW_SESSIONS_LOG!,
      `${JSON.stringify({
        tool: "review:router",
        project: "/Users/jkrumm/SourceRoot/sideclaw",
        tsStart: "2026-09-24T18:22:19.444Z",
        tsEnd: "2026-09-24T18:22:35.797Z",
      })}\n`,
    );

    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "worker-req");
    expect(record?.subTool).toBe("sideclaw:review");
  });

  test("a session_env line without a lane does NOT fall back, even when a sideclaw window matches", async () => {
    // The bug this guards against: a manual `c`/`ca` session (session_env line
    // exists, no USAGE_LANE set) whose timestamp happens to fall inside an
    // unrelated, concurrent sideclaw window must stay unattributed rather than
    // being mislabeled as that sideclaw tool.
    const line = `${JSON.stringify({
      type: "assistant",
      requestId: "manual-req",
      sessionId: "session-1",
      timestamp: "2026-09-24T18:22:30.000Z",
      cwd: "/Users/jkrumm/SourceRoot/sideclaw",
      message: {
        id: "msg-manual-req",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), line);
    writeFileSync(
      join(localLogsDir, "2026-09-10.jsonl"),
      `${JSON.stringify({ event: "session_env", data: { session: "session-1", base_url: "https://iu" } })}\n`,
    );
    writeFileSync(
      process.env.SIDECLAW_SESSIONS_LOG!,
      `${JSON.stringify({
        tool: "review:router",
        project: "/Users/jkrumm/SourceRoot/sideclaw",
        tsStart: "2026-09-24T18:22:19.444Z",
        tsEnd: "2026-09-24T18:22:35.797Z",
      })}\n`,
    );

    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "manual-req");
    expect(record?.subTool).toBeFalsy();
  });

  test("reads the provider-reported thinking token count off usage.output_tokens_details", async () => {
    const line = `${JSON.stringify({
      type: "assistant",
      requestId: "thinking-req",
      sessionId: "session-1",
      timestamp: new Date().toISOString(),
      message: {
        id: "msg-thinking-req",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 10,
          output_tokens: 500,
          output_tokens_details: { thinking_tokens: 187 },
        },
      },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), line);
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "thinking-req");
    expect(record?.reasoningTokens).toBe(187);
  });

  test("a response with no thinking usage defaults reasoningTokens to 0", async () => {
    writeFileSync(join(localDir, "local-session.jsonl"), assistantLine("local-req"));
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "local-req");
    expect(record?.reasoningTokens).toBe(0);
  });

  test("a local API-error line (isApiErrorMessage) becomes a zero-token error row", async () => {
    const errorLine = `${JSON.stringify({
      type: "assistant",
      uuid: "err-uuid-1",
      sessionId: "session-1",
      timestamp: new Date().toISOString(),
      cwd: "/Users/j/proj",
      error: "rate_limit",
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        model: "<synthetic>",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), errorLine);
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.sourceId).toBe("err-uuid-1");
    expect(record.outcome).toBe("error");
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
    expect(record.raw?.error).toBe("rate_limit");
    expect(record.raw?.apiErrorStatus).toBe(429);
  });

  test("a synthetic line with no isApiErrorMessage is still dropped", async () => {
    const line = `${JSON.stringify({
      type: "assistant",
      uuid: "synthetic-uuid",
      sessionId: "session-1",
      timestamp: new Date().toISOString(),
      message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), line);
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    expect(result.records).toHaveLength(0);
  });

  test("derives duration_ms from the gap to the parentUuid's timestamp", async () => {
    const parentTs = "2026-09-10T10:00:00.000Z";
    const childTs = "2026-09-10T10:00:03.500Z";
    const parentLine = `${JSON.stringify({
      type: "user",
      uuid: "parent-uuid",
      sessionId: "session-1",
      timestamp: parentTs,
    })}\n`;
    const childLine = `${JSON.stringify({
      type: "assistant",
      uuid: "child-uuid",
      parentUuid: "parent-uuid",
      requestId: "duration-req",
      sessionId: "session-1",
      timestamp: childTs,
      message: {
        id: "msg-duration-req",
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`;
    writeFileSync(join(localDir, "local-session.jsonl"), parentLine + childLine);
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "duration-req");
    expect(record?.durationMs).toBe(3500);
  });

  test("duration_ms is null when the parentUuid isn't in the same read (e.g. a resumed offset)", async () => {
    writeFileSync(join(localDir, "local-session.jsonl"), assistantLine("local-req"));
    setSyncOverrideForTest(async () => ({ ok: true, logsOk: true, codexOk: true, usageJsonlOk: true }));

    const result = await claudeCodeCollector.collect({ cursor: null, full: true, log });

    const record = result.records.find((r) => r.sourceId === "local-req");
    expect(record?.durationMs).toBeNull();
  });
});
