import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iumacUsageJsonlDir } from "../remote.ts";
import type { Logger } from "../types.ts";
import { astraCollector } from "./astra.ts";

// Pins the offset-incremental jsonl read (cloned from sideclaw-iu.ts) and the
// input_tokens/cached_tokens split, which mirrors codex.ts's Responses-shaped
// usage handling: input_tokens is inclusive of cached_tokens, reasoning_tokens
// is additive (not nested in output_tokens — astra.sh's own log format, not a
// raw vendor payload).

const log: Logger = { info() {}, warn() {}, error() {} };

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("astra collector", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-astra-"));
    file = join(dir, "astra.jsonl");
    process.env.USAGE_ASTRA_DIR = dir;
    // collect() now calls syncIumac() itself (see astra.ts) — hard-disable it
    // so these local-root tests never spawn a real ssh/rsync.
    process.env.USAGE_IUMAC_DISABLE = "1";
  });

  afterEach(() => {
    delete process.env.USAGE_ASTRA_DIR;
    delete process.env.USAGE_IUMAC_DISABLE;
    rmSync(dir, { recursive: true, force: true });
  });

  test("splits cached_tokens out of input_tokens and keeps reasoning_tokens additive", async () => {
    writeFileSync(
      file,
      line({
        ts: "2026-09-10T13:04:27Z",
        request_id: "resp_abc123",
        model: "gpt-6-astra",
        input_tokens: 1234,
        output_tokens: 567,
        reasoning_tokens: 890,
        cached_tokens: 200,
        effort: "xhigh",
        mode: "pro",
        outcome: "ok",
        duration_ms: 41230,
      }),
    );

    const { records } = await astraCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sourceId).toBe("resp_abc123");
    expect(r.grain).toBe("message");
    expect(r.model).toBe("gpt-6-astra");
    expect(r.project).toBe("astra");
    expect(r.subTool).toBe("pro"); // mode
    expect(r.inputTokens).toBe(1034); // 1234 - 200 cached
    expect(r.cacheReadTokens).toBe(200);
    expect(r.outputTokens).toBe(567);
    expect(r.reasoningTokens).toBe(890); // additive, not subtracted from output
    expect(r.durationMs).toBe(41230);
    expect(r.outcome).toBe("ok");
  });

  test("advances the byte offset across two runs and dedups nothing it hasn't seen", async () => {
    writeFileSync(
      file,
      line({ request_id: "resp-1", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }),
    );

    const first = await astraCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId)).toEqual(["resp-1"]);

    writeFileSync(
      file,
      line({ request_id: "resp-1", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }) +
        line({ request_id: "resp-2", model: "gpt-6-astra", input_tokens: 20, output_tokens: 2 }),
    );

    const second = await astraCollector.collect({ cursor: first.cursor, full: false, log });
    expect(second.records.map((r) => r.sourceId)).toEqual(["resp-2"]);
  });

  test("holds the offset on a half-written trailing line", async () => {
    writeFileSync(
      file,
      line({ request_id: "resp-1", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }).trimEnd(),
    );

    const { records } = await astraCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("drops a row with no request_id and warns", async () => {
    const warnings: string[] = [];
    const capturing: Logger = { info() {}, warn: (m) => warnings.push(m), error() {} };
    writeFileSync(file, line({ model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }));

    const { records } = await astraCollector.collect({ cursor: null, full: false, log: capturing });

    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test("available() is false when the log is absent, without throwing", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(astraCollector.available()).toBe(false);
  });

  test("migrates a legacy {offset:N} cursor to the local file's per-path offset entry", async () => {
    const firstLine = line({ request_id: "resp-1", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 });
    const secondLine = line({ request_id: "resp-2", model: "gpt-6-astra", input_tokens: 20, output_tokens: 2 });
    writeFileSync(file, firstLine + secondLine);

    // The pre-two-root collector persisted this shape after reading resp-1.
    const legacyCursor = JSON.stringify({ offset: Buffer.byteLength(firstLine) });

    const { records, cursor } = await astraCollector.collect({ cursor: legacyCursor, full: false, log });

    expect(records.map((r) => r.sourceId)).toEqual(["resp-2"]);
    const offsets = JSON.parse(cursor ?? "{}") as Record<string, { offset: number }>;
    expect(offsets[file]?.offset).toBeGreaterThan(0);
  });
});

// Mirrors codex.test.ts's iumac-mirror coverage: one shared cursor across
// local + mirror files, mirror rows carrying the MacBook's machine label, and
// the basename filter that keeps a sibling jsonl (e.g. sideclaw-iu.jsonl) in
// the same mirror directory from being swallowed by this collector.
// USAGE_IUMAC_DISABLE keeps collect()'s own syncIumac() call from ever
// spawning ssh/rsync — the mirror fixture is placed on disk directly instead.
describe("astra collector — iumac mirror", () => {
  let localDir: string;
  let remoteDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "usage-tracker-astra-local-"));
    remoteDir = mkdtempSync(join(tmpdir(), "usage-tracker-astra-remote-"));
    process.env.USAGE_ASTRA_DIR = localDir;
    process.env.USAGE_REMOTE_DIR = remoteDir;
    process.env.USAGE_IUMAC_MACHINE = "MacBook Pro (Test)";
    process.env.USAGE_IUMAC_DISABLE = "1";
  });

  afterEach(() => {
    delete process.env.USAGE_ASTRA_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    delete process.env.USAGE_IUMAC_MACHINE;
    delete process.env.USAGE_IUMAC_DISABLE;
    rmSync(localDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  test("reads both roots into one cursor; mirror rows carry the MacBook's machine, local rows leave it null", async () => {
    const localFile = join(localDir, "astra.jsonl");
    writeFileSync(
      localFile,
      line({ request_id: "local-resp", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }),
    );

    const mirrorDir = iumacUsageJsonlDir();
    mkdirSync(mirrorDir, { recursive: true });
    const mirrorFile = join(mirrorDir, "astra.jsonl");
    writeFileSync(
      mirrorFile,
      line({ request_id: "mirror-resp", model: "gpt-6-astra", input_tokens: 20, output_tokens: 2 }),
    );

    const { records, cursor } = await astraCollector.collect({ cursor: null, full: false, log });

    const localRecord = records.find((r) => r.sourceId === "local-resp");
    const mirrorRecord = records.find((r) => r.sourceId === "mirror-resp");
    expect(localRecord?.machine).toBeNull();
    expect(mirrorRecord?.machine).toBe("MacBook Pro (Test)");

    const offsets = JSON.parse(cursor ?? "{}") as Record<string, { offset: number }>;
    expect(offsets[localFile]?.offset).toBeGreaterThan(0);
    expect(offsets[mirrorFile]?.offset).toBeGreaterThan(0);
  });

  test("a sibling jsonl file in the mirror dir is ignored (basename filter)", async () => {
    const mirrorDir = iumacUsageJsonlDir();
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(
      join(mirrorDir, "astra.jsonl"),
      line({ request_id: "mirror-resp", model: "gpt-6-astra", input_tokens: 20, output_tokens: 2 }),
    );
    writeFileSync(
      join(mirrorDir, "sideclaw-iu.jsonl"),
      `${JSON.stringify({ request_id: "sideclaw-resp", tool: "check" })}\n`,
    );

    const { records } = await astraCollector.collect({ cursor: null, full: false, log });

    expect(records.map((r) => r.sourceId)).toEqual(["mirror-resp"]);
  });

  test("a missing mirror root is skipped, not treated as an error", async () => {
    const localFile = join(localDir, "astra.jsonl");
    writeFileSync(
      localFile,
      line({ request_id: "local-resp", model: "gpt-6-astra", input_tokens: 10, output_tokens: 1 }),
    );
    // Deliberately no iumacUsageJsonlDir() on disk at all.

    const { records } = await astraCollector.collect({ cursor: null, full: false, log });

    expect(records.map((r) => r.sourceId)).toEqual(["local-resp"]);
  });
});
