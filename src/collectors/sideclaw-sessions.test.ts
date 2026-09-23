import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { sideclawSessionsCollector } from "./sideclaw-sessions.ts";

// Pins the offset-incremental read (same shape as sideclaw-iu.ts), the
// zero-token/session-grain shape (this source carries no token counts at
// all), the outcome collapse ("timeout" -> "error", raw.rawOutcome keeps the
// original), and tolerance for a line missing fields that only landed on the
// log later.

const log: Logger = { info() {}, warn() {}, error() {} };

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("sideclaw-sessions collector", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-sideclaw-sessions-"));
    file = join(dir, "sideclaw-sessions.jsonl");
    process.env.SIDECLAW_SESSIONS_USAGE_LOG = file;
  });

  afterEach(() => {
    delete process.env.SIDECLAW_SESSIONS_USAGE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps a session line to a zero-token, session-grain record", async () => {
    writeFileSync(
      file,
      line({
        sessionId: "sess-1",
        tool: "review:angle",
        project: "/Users/j/SourceRoot/homelab-private",
        model: "claude-sonnet-5[1m]",
        backend: "max",
        tsStart: "2026-09-11T15:29:27.084Z",
        tsEnd: "2026-09-11T15:29:37.930Z",
        outcome: "ok",
        durationMs: 10845,
        turns: 4,
      }),
    );

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sourceId).toBe("sess-1");
    expect(r.grain).toBe("session");
    expect(r.model).toBe("claude-sonnet-5[1m]");
    expect(r.project).toBe("/Users/j/SourceRoot/homelab-private");
    expect(r.subTool).toBe("review:angle");
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.durationMs).toBe(10845);
    expect(r.outcome).toBe("ok");
    expect(r.raw?.backend).toBe("max");
    expect(r.raw?.turns).toBe(4);
  });

  test("collapses a 'timeout' outcome to 'error' but keeps the original in raw", async () => {
    writeFileSync(
      file,
      line({
        sessionId: "sess-2",
        tool: "probe",
        model: "gemini-3.5-flash",
        backend: "iu",
        outcome: "timeout",
        exitCode: 143,
        reason: "no_output",
      }),
    );

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    const r = records[0]!;
    expect(r.outcome).toBe("error");
    expect(r.raw?.rawOutcome).toBe("timeout");
    expect(r.raw?.exitCode).toBe(143);
    expect(r.raw?.reason).toBe("no_output");
  });

  test("an explicit 'error' outcome maps straight through", async () => {
    writeFileSync(
      file,
      line({ sessionId: "sess-3", model: "claude-sonnet-5", backend: "max", outcome: "error" }),
    );

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    expect(records[0]!.outcome).toBe("error");
  });

  test("a line missing fields that only exist on newer rows doesn't throw", async () => {
    writeFileSync(file, line({ sessionId: "sess-4" }));

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.outcome).toBe("ok");
    expect(r.model).toBeNull();
    expect(r.durationMs).toBeNull();
    expect(r.raw).toBeUndefined();
  });

  test("drops a row with no sessionId", async () => {
    writeFileSync(file, line({ tool: "check", outcome: "ok" }));

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("advances the byte offset across two runs", async () => {
    writeFileSync(file, line({ sessionId: "sess-1", outcome: "ok" }));

    const first = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId)).toEqual(["sess-1"]);

    writeFileSync(
      file,
      line({ sessionId: "sess-1", outcome: "ok" }) + line({ sessionId: "sess-2", outcome: "ok" }),
    );

    const second = await sideclawSessionsCollector.collect({ cursor: first.cursor, full: false, log });
    expect(second.records.map((r) => r.sourceId)).toEqual(["sess-2"]);
  });

  test("holds the offset on a half-written trailing line", async () => {
    writeFileSync(file, line({ sessionId: "sess-1", outcome: "ok" }).trimEnd());

    const { records } = await sideclawSessionsCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("available() is false when the log is absent, without throwing", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(sideclawSessionsCollector.available()).toBe(false);
  });
});
