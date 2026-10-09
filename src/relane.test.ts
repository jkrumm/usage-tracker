import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { formatRelane, relane, resolveSessionLanes, scanEntrypoints } from "./relane.ts";

describe("resolveSessionLanes", () => {
  test("cli: NULL and sideclaw:* rows take the session's explicit lane, else interactive", () => {
    expect(resolveSessionLanes([null, "sideclaw:review", "wave", "wave"], "cli")).toEqual([
      "wave",
      "wave",
      "wave",
      "wave",
    ]);
    expect(resolveSessionLanes([null, "sideclaw:check"], "cli")).toEqual(["interactive", "interactive"]);
  });

  test("claude-desktop resolves like cli, to desktop", () => {
    expect(resolveSessionLanes([null, "sideclaw:check", "bg"], "claude-desktop")).toEqual(["bg", "bg", "bg"]);
    expect(resolveSessionLanes([null, "sideclaw:check"], "claude-desktop")).toEqual(["desktop", "desktop"]);
  });

  test("generic lanes are not explicit evidence and non-agent-gateway lanes are left alone", () => {
    expect(resolveSessionLanes([null, "interactive", "warden", "headless"], "cli")).toEqual([
      "warden",
      "interactive",
      "warden",
      "headless",
    ]);
  });

  test("the most frequent explicit lane wins", () => {
    expect(resolveSessionLanes([null, "bg", "fleet", "fleet"], "cli")).toEqual(["fleet", "bg", "fleet", "fleet"]);
  });

  test("sdk-cli: NULL rows take a non-agent-gateway explicit lane, else headless; agent-gateway rows stay", () => {
    expect(resolveSessionLanes([null, "sideclaw:review"], "sdk-cli")).toEqual(["headless", "sideclaw:review"]);
    expect(resolveSessionLanes([null, null], "sdk-cli")).toEqual(["headless", "headless"]);
    expect(resolveSessionLanes([null, "sideclaw:review", "wave", "wave"], "sdk-cli")).toEqual([
      "wave",
      "sideclaw:review",
      "wave",
      "wave",
    ]);
  });

  test("unknown entrypoint: NULL rows take the session's explicit lane, agent-gateway rows stay", () => {
    expect(resolveSessionLanes([null, null], null)).toEqual([null, null]);
    expect(resolveSessionLanes([null, "bg"], null)).toEqual(["bg", "bg"]);
    expect(resolveSessionLanes(["sideclaw:review", "sideclaw:review"], null)).toEqual(["sideclaw:review", "sideclaw:review"]);
    expect(resolveSessionLanes([null], "vscode")).toEqual([null]);
  });

  test("unknown entrypoint mixing NULL and sideclaw:* rows is a pruned interactive session", () => {
    expect(resolveSessionLanes([null, "bg", "sideclaw:review"], null)).toEqual(["bg", "bg", "bg"]);
    expect(resolveSessionLanes([null, "sideclaw:review"], null)).toEqual(["interactive", "interactive"]);
  });
});

describe("relane end to end", () => {
  let dir: string;
  let db: Database;

  const transcript = (sessionId: string, entrypoint: string) =>
    `${JSON.stringify({ type: "queue-operation", operation: "enqueue" })}\n` +
    `${JSON.stringify({ type: "user", sessionId, entrypoint, cwd: "/tmp/p" })}\n`;

  function insert(sourceId: string, session: string, subTool: string | null, opts: { model?: string; billing?: string; source?: string } = {}): void {
    db.prepare(
      `INSERT INTO usage_record
        (source, source_id, grain, ts, model, model_norm, sub_tool, billing, cost_usd, raw, ingested_at, synced_at)
       VALUES ($source, $source_id, 'message', '2026-10-01T00:00:00Z', $model, $model, $sub_tool, $billing, 1.5,
               $raw, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
    ).run({
      $source: opts.source ?? "claude-code",
      $source_id: sourceId,
      $model: opts.model ?? "claude-sonnet-5",
      $sub_tool: subTool,
      $billing: opts.billing ?? "max",
      $raw: JSON.stringify({ sessionId: session }),
    });
  }

  function snapshot(): Array<{ source_id: string; sub_tool: string | null; billing: string; synced_at: string | null }> {
    return db
      .query<{ source_id: string; sub_tool: string | null; billing: string; synced_at: string | null }, []>(
        "SELECT source_id, sub_tool, billing, synced_at FROM usage_record ORDER BY source_id",
      )
      .all();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-relane-"));
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "proj-a", "s-sdk", "subagents"), { recursive: true });
    writeFileSync(join(projects, "proj-a", "s-cli.jsonl"), transcript("s-cli", "cli"));
    writeFileSync(join(projects, "proj-a", "s-cli2.jsonl"), transcript("s-cli2", "cli"));
    writeFileSync(join(projects, "proj-a", "s-sdk2.jsonl"), transcript("s-sdk2", "sdk-cli"));
    writeFileSync(join(projects, "proj-a", "s-max.jsonl"), transcript("s-max", "cli"));
    // The sdk-cli session's only transcript is a subagent file.
    writeFileSync(join(projects, "proj-a", "s-sdk", "subagents", "agent-1.jsonl"), transcript("s-sdk", "sdk-cli"));
    process.env.USAGE_CLAUDE_PROJECTS_DIR = projects;
    process.env.USAGE_REMOTE_DIR = join(dir, "no-mirror");

    db = openDb(join(dir, "usage.db"));
    insert("cli-1", "s-cli", null);
    insert("cli-2", "s-cli", "sideclaw:review");
    insert("cli-3", "s-cli", "wave");
    insert("cli-4", "s-cli", "wave");
    insert("cli2-1", "s-cli2", null);
    insert("cli2-2", "s-cli2", "sideclaw:check");
    insert("sdk-1", "s-sdk", null);
    insert("sdk-2", "s-sdk", "sideclaw:implement");
    insert("sdk2-1", "s-sdk2", null);
    insert("gone-1", "s-gone", null);
    insert("gone-2", "s-gone", "bg");
    insert("lost-1", "s-lost", null);
    insert("max-1", "s-max", null);
    insert("max-2", "s-max", null, { model: "<synthetic>", billing: "iu" });
    insert("iu-1", "s-iu", "bg", { billing: "iu" });
    insert("iu-synth", "s-iu", "bg", { model: "<synthetic>", billing: "iu" });
    insert("other-1", "s-cli", null, { source: "hermes" });
  });

  afterEach(() => {
    delete process.env.USAGE_CLAUDE_PROJECTS_DIR;
    delete process.env.USAGE_REMOTE_DIR;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("scanEntrypoints reads the first line carrying both fields, subagent files included", async () => {
    const map = await scanEntrypoints();
    expect(map.get("s-cli")).toBe("cli");
    expect(map.get("s-sdk")).toBe("sdk-cli");
    expect(map.has("s-gone")).toBe(false);
  });

  test("scanEntrypoints reads past the head prefix when the first line is huge", async () => {
    const big = `${JSON.stringify({ type: "summary", text: "x".repeat(300 * 1024) })}\n`;
    writeFileSync(join(process.env.USAGE_CLAUDE_PROJECTS_DIR!, "proj-a", "s-big.jsonl"), big + transcript("s-big", "cli"));
    expect((await scanEntrypoints()).get("s-big")).toBe("cli");
  });

  test("dry run reports per old -> new lane counts and cost without writing", async () => {
    const before = snapshot();
    const result = relane(db, await scanEntrypoints(), { dryRun: true });

    expect(snapshot()).toEqual(before);
    expect(result.dryRun).toBe(true);
    const t = (from: string | null, to: string | null) =>
      result.transitions.find((x) => x.from === from && x.to === to);
    expect(t(null, "wave")).toMatchObject({ rows: 1, costUsd: 1.5 });
    expect(t("sideclaw:review", "wave")?.rows).toBe(1);
    expect(t(null, "interactive")?.rows).toBe(3); // cli2-1 + max-1 + max-2 (synthetic)
    expect(t("sideclaw:check", "interactive")?.rows).toBe(1);
    expect(t(null, "headless")?.rows).toBe(2); // sdk2-1 + sdk-1
    expect(t(null, "sideclaw:implement")).toBeUndefined();
    expect(t(null, "bg")?.rows).toBe(1);
    expect(formatRelane(result)).toContain("dry run");
  });

  test("applies the resolver, fixes synthetic billing, clears synced_at on changed rows only", async () => {
    const result = relane(db, await scanEntrypoints());
    const rows = new Map(snapshot().map((r) => [r.source_id, r]));
    const synced = "2026-10-02T00:00:00Z";

    expect(rows.get("cli-1")).toMatchObject({ sub_tool: "wave", synced_at: null });
    expect(rows.get("cli-2")).toMatchObject({ sub_tool: "wave", synced_at: null });
    expect(rows.get("cli-3")).toMatchObject({ sub_tool: "wave", synced_at: synced });
    expect(rows.get("cli2-1")?.sub_tool).toBe("interactive");
    expect(rows.get("cli2-2")?.sub_tool).toBe("interactive");
    expect(rows.get("sdk-1")?.sub_tool).toBe("headless"); // an agent-gateway lane never propagates to NULL rows
    expect(rows.get("sdk2-1")?.sub_tool).toBe("headless");
    expect(rows.get("sdk-2")).toMatchObject({ sub_tool: "sideclaw:implement", synced_at: synced });
    expect(rows.get("gone-1")?.sub_tool).toBe("bg");
    expect(rows.get("gone-2")).toMatchObject({ sub_tool: "bg", synced_at: synced });
    expect(rows.get("lost-1")).toMatchObject({ sub_tool: null, synced_at: synced });
    expect(rows.get("other-1")).toMatchObject({ sub_tool: null, synced_at: synced });

    expect(rows.get("max-2")).toMatchObject({ billing: "max", synced_at: null });
    // No non-synthetic max row in its session: stays iu.
    expect(rows.get("iu-synth")).toMatchObject({ billing: "iu", synced_at: synced });
    expect(result.billingFixed).toBe(1);

    const raw = db
      .query<{ raw: string }, []>("SELECT raw FROM usage_record WHERE source_id = 'cli2-1'")
      .get();
    expect(JSON.parse(raw!.raw)).toEqual({ sessionId: "s-cli2", entrypoint: "cli" });

    // Idempotent: a second run has nothing left to do.
    expect(relane(db, await scanEntrypoints()).changed).toBe(0);
  });
});
