import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertRecords } from "../db.ts";
import { computeCost } from "../pricing.ts";
import type { Logger } from "../types.ts";
import { audioGatewayCollector, toRecord, type LedgerRow } from "./audio-gateway.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const log: Logger = { info() {}, warn() {}, error() {} };

function ledger(path: string, rows: Array<Partial<LedgerRow> & { id: number }>) {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE usage_record (id INTEGER PRIMARY KEY, ts TEXT, endpoint TEXT, model TEXT, status INTEGER,
    latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, audio_seconds REAL, input_chars INTEGER,
    usage_json TEXT, error_text TEXT, caller TEXT)`);
  for (const r of rows) {
    db.run("INSERT INTO usage_record VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [
      r.id, r.ts ?? "2026-10-24T10:00:00.000Z", r.endpoint ?? "podcast-segment", r.model ?? "claude-opus-5-5",
      r.status ?? 200, r.latency_ms ?? 100, r.input_tokens ?? null, r.output_tokens ?? null,
      r.audio_seconds ?? null, r.input_chars ?? null, r.usage_json ?? null, r.error_text ?? null, r.caller ?? null,
    ]);
  }
  db.close();
}

const L = { name: "mini" };

describe("audio-gateway collector", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-audio-gateway-"));
    process.env.AUDIO_GATEWAY_DATA_DIR = dir;
  });
  afterEach(() => {
    delete process.env.AUDIO_GATEWAY_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps Anthropic, OpenAI and audio shapes; skips wrappers and empty rows", () => {
    const base = { id: 1, ts: "2026-10-24T10:00:00.000Z", endpoint: "podcast-segment", model: "claude-opus-5-5", status: 200, latency_ms: 5, input_tokens: null, output_tokens: null, audio_seconds: null, input_chars: null, usage_json: null, error_text: null, caller: "claude-code" };
    const anth = toRecord(L, { ...base, usage_json: '{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}' })!;
    expect([anth.inputTokens, anth.outputTokens, anth.cacheReadTokens, anth.cacheWriteTokens]).toEqual([100, 20, 50, 10]);
    expect(anth.sourceId).toBe("mini:1@2026-10-24T10:00:00.000Z");
    expect(anth.subTool).toBe("podcast-segment");

    const oai = toRecord(L, { ...base, id: 2, model: "deepseek-v4.1-flash", usage_json: '{"prompt_tokens":485,"completion_tokens":1415,"prompt_tokens_details":{"cached_tokens":384},"completion_tokens_details":{"reasoning_tokens":1320},"cost":0.00128}' })!;
    expect([oai.inputTokens, oai.outputTokens, oai.cacheReadTokens, oai.reasoningTokens]).toEqual([101, 95, 384, 1320]);
    expect(oai.authoritativeCostUsd).toBe(0.00128);

    const tts = toRecord({ name: "vps", machine: "vps" }, { ...base, id: 3, endpoint: "speech", model: "elevenlabs/v3", audio_seconds: 12.5, input_chars: 300 })!;
    expect(tts.raw).toMatchObject({ unpriced: true, audioSeconds: 12.5 });
    expect(tts.machine).toBe("vps");

    expect(toRecord(L, { ...base, id: 4, endpoint: "speech-request", audio_seconds: 12.5 })).toBeNull();
    expect(toRecord(L, { ...base, id: 5 })).toBeNull();
    expect(toRecord(L, { ...base, id: 6, status: 500, input_tokens: 5 })!.outcome).toBe("error");
    expect(toRecord(L, { ...base, id: 7, status: 502 })!.outcome).toBe("error");
  });

  test("reads main and lab ledgers incrementally, prices from the rate card", async () => {
    ledger(join(dir, "usage.db"), [
      { id: 1, usage_json: '{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0}' },
    ]);
    mkdirSync(join(dir, "writer-lab"));
    ledger(join(dir, "writer-lab", "usage.db"), [
      { id: 1, model: "claude-sonnet-5-5", usage_json: '{"input_tokens":10,"output_tokens":5}' },
    ]);

    const first = await audioGatewayCollector.collect({ cursor: null, full: false, log });
    expect(first.records.map((r) => r.sourceId).sort()).toEqual(["mini/writer-lab:1@2026-10-24T10:00:00.000Z", "mini:1@2026-10-24T10:00:00.000Z"]);

    const again = await audioGatewayCollector.collect({ cursor: first.cursor, full: false, log });
    expect(again.records).toHaveLength(0);

    const db = new Database(join(dir, "usage.db"));
    db.run("INSERT INTO usage_record (id, ts, endpoint, model, status, usage_json) VALUES (2,'2026-10-25T10:00:00.000Z','podcast-segment','claude-opus-5-5',200,'{\"input_tokens\":7,\"output_tokens\":1}')");
    db.close();
    const next = await audioGatewayCollector.collect({ cursor: first.cursor, full: false, log });
    expect(next.records.map((r) => r.sourceId)).toEqual(["mini:2@2026-10-25T10:00:00.000Z"]);

    const udb = openDb(join(dir, "tracker.db"));
    upsertRecords(udb, "audio-gateway", first.records);
    const row = udb.query("SELECT billing, cost_usd FROM usage_record WHERE source_id='mini:1@2026-10-24T10:00:00.000Z'").get() as { billing: string; cost_usd: number };
    expect(row.billing).toBe("iu");
    expect(row.cost_usd).toBeCloseTo(computeCost("claude-opus-5-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, grain: "message" }).usd!, 5);
    udb.close();
  });

  test("a recreated ledger (max id below the watermark) is rescanned", async () => {
    ledger(join(dir, "usage.db"), Array.from({ length: 60 }, (_, i) => ({ id: i + 1, usage_json: '{"input_tokens":5,"output_tokens":1}' })));
    const res = await audioGatewayCollector.collect({ cursor: JSON.stringify({ mini: { id: 50, gen: "2026-01-01T00:00:00.000Z" } }), full: false, log });
    expect(res.records).toHaveLength(60);
    expect(res.cursor).toBe(JSON.stringify({ mini: { id: 60, gen: "2026-10-24T10:00:00.000Z" } }));
    const idle = await audioGatewayCollector.collect({ cursor: res.cursor, full: false, log });
    expect(idle.records).toHaveLength(0);
  });
});
