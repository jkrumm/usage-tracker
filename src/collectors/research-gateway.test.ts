import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "../db.ts";
import { computeCost } from "../pricing.ts";
import type { Logger } from "../types.ts";
import { researchGatewayCollector } from "./research-gateway.ts";

// Pins the offset-incremental read (same shape as sideclaw-iu.ts), the
// partial-line and truncation behavior, the three cost rules (model rows are
// priced centrally, `cost_source:"reported"` keeps the vendor cost, no model /
// no cost stays null), central machine stamping, and last-line-wins on a
// re-sent (source, source_id).

process.env.USAGE_MACHINE = "Test Machine (Override)";

const log: Logger = { info() {}, warn() {}, error() {} };

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

function base(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "research-gateway",
    grain: "session",
    ts: "2026-09-23T10:00:00.000Z",
    project: "research-gateway",
    workspace: "private",
    machine: "mini",
    ...overrides,
  };
}

describe("research-gateway collector", () => {
  let dir: string;
  let file: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-research-gateway-"));
    file = join(dir, "research-gateway.jsonl");
    process.env.RESEARCH_GATEWAY_USAGE_LOG = file;
    db = openDb(join(dir, "usage.db"));
  });

  afterEach(() => {
    db.close();
    delete process.env.RESEARCH_GATEWAY_USAGE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps a line to a session-grain record and leaves machine for central stamping", async () => {
    writeFileSync(
      file,
      line(
        base({
          source_id: "job1:lead",
          model: "deepseek-v4.1-flash",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          reasoning_tokens: 100,
          duration_ms: 4200,
          sub_tool: "sonar",
          outcome: "timeout",
          raw: { note: "kept" },
          cost_source: "none",
          cost_usd: null,
        }),
      ),
    );

    const { records } = await researchGatewayCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.sourceId).toBe("job1:lead");
    expect(r.grain).toBe("session");
    expect(r.model).toBe("deepseek-v4.1-flash");
    expect(r.project).toBe("research-gateway");
    expect(r.subTool).toBe("sonar");
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(500);
    expect(r.cacheReadTokens).toBe(200);
    expect(r.reasoningTokens).toBe(100);
    expect(r.durationMs).toBe(4200);
    expect(r.outcome).toBe("error");
    expect(r.raw?.rawOutcome).toBe("timeout");
    expect(r.raw?.raw).toEqual({ note: "kept" });
    // machine is never set by the collector — upsertRecords stamps it.
    expect(r.machine).toBeUndefined();
  });

  test("tolerates a half-written trailing line", async () => {
    writeFileSync(
      file,
      line(base({ source_id: "job1:lead", cost_source: "none" })).trimEnd(),
    );

    const { records } = await researchGatewayCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("drops a row with no source_id", async () => {
    writeFileSync(file, line(base({ model: "deepseek-v4.1-flash", cost_source: "computed" })));

    const { records } = await researchGatewayCollector.collect({ cursor: null, full: false, log });

    expect(records).toHaveLength(0);
  });

  test("advances the byte offset across two runs", async () => {
    writeFileSync(file, line(base({ source_id: "job1:lead", cost_source: "none" })));
    const first = await researchGatewayCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId)).toEqual(["job1:lead"]);

    writeFileSync(
      file,
      line(base({ source_id: "job1:lead", cost_source: "none" })) +
        line(base({ source_id: "job2:lead", cost_source: "none" })),
    );
    const second = await researchGatewayCollector.collect({
      cursor: first.cursor,
      full: false,
      log,
    });

    expect(second.records.map((r) => r.sourceId)).toEqual(["job2:lead"]);
  });

  test("recovers from a truncated/rotated file instead of stalling past EOF", async () => {
    writeFileSync(
      file,
      line(
        base({
          source_id: "job1:lead",
          model: "deepseek-v4.1-flash",
          input_tokens: 123456,
          output_tokens: 654321,
          cost_source: "computed",
        }),
      ),
    );
    const first = await researchGatewayCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId)).toEqual(["job1:lead"]);

    // Replace the file with shorter content — size drops below the stored offset.
    writeFileSync(file, line(base({ source_id: "job2:lead", cost_source: "none" })));
    const second = await researchGatewayCollector.collect({
      cursor: first.cursor,
      full: false,
      log,
    });

    expect(second.records.map((r) => r.sourceId)).toEqual(["job2:lead"]);
  });

  test("applies the three cost rules and ignores the line's machine", async () => {
    writeFileSync(
      file,
      line(
        base({
          source_id: "job1:lead",
          model: "deepseek-v4.1-flash",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          reasoning_tokens: 100,
          cost_usd: 999.99,
          cost_source: "computed",
        }),
      ) +
        line(
          base({
            source_id: "job1:sonar",
            model: null,
            cost_usd: 0.042,
            cost_source: "reported",
            sub_tool: "sonar",
          }),
        ) +
        line(
          base({
            source_id: "tavily-account",
            model: null,
            cost_usd: null,
            cost_source: "none",
            sub_tool: "tavily",
          }),
        ),
    );

    const { records } = await researchGatewayCollector.collect({ cursor: null, full: false, log });
    // Mirror ingest's workspace plumbing so the collector default is exercised.
    upsertRecords(db, "research-gateway", records, {
      defaultWorkspace: researchGatewayCollector.workspace ?? null,
    });

    const rows = db
      .query<
        {
          source_id: string;
          cost_usd: number | null;
          cost_source: string;
          machine: string | null;
          workspace: string | null;
        },
        []
      >("SELECT source_id, cost_usd, cost_source, machine, workspace FROM usage_record ORDER BY source_id")
      .all();
    const byId = new Map(rows.map((r) => [r.source_id, r]));

    // A model row is priced centrally; the line's bogus cost_usd is ignored.
    const expectedLlm = computeCost("deepseek-v4.1-flash", {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 100,
      grain: "session",
    });
    expect(byId.get("job1:lead")?.cost_source).toBe("computed");
    expect(byId.get("job1:lead")?.cost_usd).toBeCloseTo(expectedLlm.usd!, 10);

    // A vendor-reported row keeps the line's cost.
    expect(byId.get("job1:sonar")?.cost_source).toBe("reported");
    expect(byId.get("job1:sonar")?.cost_usd).toBeCloseTo(0.042, 10);

    // No model / no cost stays null.
    expect(byId.get("tavily-account")?.cost_source).toBe("none");
    expect(byId.get("tavily-account")?.cost_usd).toBeNull();

    // machine is stamped centrally, not taken from the line's "mini"; the
    // collector pins the workspace to "private".
    for (const r of rows) {
      expect(r.machine).not.toBe("mini");
      expect(r.workspace).toBe("private");
    }
  });

  test("a re-sent source_id updates in place — last line wins", async () => {
    writeFileSync(
      file,
      line(base({ source_id: "tavily-account", model: null, cost_usd: 1, cost_source: "reported" })),
    );
    const first = await researchGatewayCollector.collect({ cursor: null, full: false, log });
    upsertRecords(db, "research-gateway", first.records);

    writeFileSync(
      file,
      line(base({ source_id: "tavily-account", model: null, cost_usd: 1, cost_source: "reported" })) +
        line(
          base({ source_id: "tavily-account", model: null, cost_usd: 2, cost_source: "reported" }),
        ),
    );
    const second = await researchGatewayCollector.collect({
      cursor: first.cursor,
      full: false,
      log,
    });
    upsertRecords(db, "research-gateway", second.records);

    const rows = db
      .query<{ cost_usd: number | null; cost_source: string }, []>(
        "SELECT cost_usd, cost_source FROM usage_record WHERE source_id = 'tavily-account'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_usd).toBe(2);
    expect(rows[0]?.cost_source).toBe("reported");
  });

  test("available() is false when the log is absent, without throwing", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(researchGatewayCollector.available()).toBe(false);
  });
});
