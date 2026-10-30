import type { SQL } from "bun";
import { beforeEach, expect, test } from "bun:test";
import { migratedDb } from "./fixture.ts";
import { describePg } from "./testing.ts";

// Migration 0007: the gateway mirror rule marks the later copy of a call that two stores recorded, never deletes, and
// leaves legitimate neighbours alone.

const pg = migratedDb();
let db: SQL;

interface R {
  id: string;
  source: string;
  machine: string;
  ts?: string;
  model?: string;
  key?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  write5m?: number;
  write1h?: number;
  billing?: string;
}

async function put(r: R): Promise<number> {
  const [row] = await db`
    INSERT INTO usage.records (source, source_id, grain, ts, model, billing, api_key, machine, input_tokens, output_tokens, reasoning_tokens,
                               cache_write_5m_tokens, cache_write_1h_tokens, cost_usd, cost_source)
    VALUES (${r.source}, ${r.id}, 'message', ${r.ts ?? "2026-10-24T10:00:00Z"}::timestamptz, ${r.model ?? "claude-opus-5-5"}, ${r.billing ?? "api_key"},
            ${r.key ?? "personal"}, ${r.machine}, ${r.input ?? 1000}, ${r.output ?? 200}, ${r.reasoning ?? 0},
            ${r.write5m ?? 0}, ${r.write1h ?? 0}, 1, 'reported')
    RETURNING id::int AS id`;
  return row.id;
}

const flagged = async () => (await db`SELECT record_id::int AS r, duplicate_of::int AS d FROM usage.record_duplicates ORDER BY 1`) as Array<{ r: number; d: number }>;

beforeEach(async () => {
  db = await pg.reset();
});

describePg("gateway mirror duplicates", () => {
  test("the later copy of a call from another store is marked, the earlier kept, nothing deleted", async () => {
    const keep = await put({ id: "a", source: "audio-gateway", machine: "Mac mini (M2 Pro)" });
    const copy = await put({ id: "b", source: "audio-gateway-mini", machine: "mini", ts: "2026-10-24T10:00:03Z" });
    const other = await put({ id: "c", source: "audio-gateway", machine: "mini", ts: "2026-10-24T10:00:09Z" });
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe("2");
    expect(await flagged()).toEqual([{ r: copy, d: keep }, { r: other, d: keep }]);
    expect((await db`SELECT count(*)::int AS n FROM usage.records`)[0]!.n).toBe(3);
    expect((await db`SELECT id::int AS id FROM usage.records_unique`).map((r: { id: number }) => r.id)).toEqual([keep]);
  });

  test("a store that lumps reasoning into output and one that keeps it apart are the same call", async () => {
    const keep = await put({ id: "a", source: "audio-gateway", machine: "Mac mini (M2 Pro)", output: 871, reasoning: 3898, write5m: 100, write1h: 50 });
    const copy = await put({ id: "b", source: "audio-gateway-mini", machine: "mini", output: 4769, reasoning: 0, write5m: 150, write1h: 0 });
    await db`SELECT usage.flag_gateway_duplicates()`;
    expect(await flagged()).toEqual([{ r: copy, d: keep }]);
  });

  test("a second run changes nothing", async () => {
    await put({ id: "a", source: "audio-gateway", machine: "Mac mini (M2 Pro)" });
    await put({ id: "b", source: "audio-gateway-vps", machine: "vps" });
    await db`SELECT usage.flag_gateway_duplicates()`;
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe("0");
  });

  test("different token counts, models, keys, a gap above 10 s, the same store or another source are not duplicates", async () => {
    await put({ id: "base", source: "audio-gateway", machine: "Mac mini (M2 Pro)" });
    await put({ id: "tokens", source: "audio-gateway-mini", machine: "mini", output: 201 });
    await put({ id: "model", source: "audio-gateway-mini", machine: "mini", model: "claude-haiku-5-5" });
    await put({ id: "key", source: "audio-gateway-mini", machine: "mini", key: "athena-team" });
    await put({ id: "late", source: "audio-gateway-mini", machine: "mini", ts: "2026-10-24T10:00:13Z" });
    await put({ id: "same-store", source: "audio-gateway", machine: "Mac mini (M2 Pro)", ts: "2026-10-24T10:00:02Z" });
    await put({ id: "elsewhere", source: "claude-code", machine: "mini" });
    await put({ id: "max", source: "audio-gateway-vps", machine: "vps", billing: "max" });
    await put({ id: "empty-a", source: "audio-gateway", machine: "a", input: 0, output: 0 });
    await put({ id: "empty-b", source: "audio-gateway-mini", machine: "b", input: 0, output: 0 });
    expect((await db`SELECT usage.flag_gateway_duplicates() AS n`)[0]!.n).toBe("0");
  });

  test("deleting the marks puts the rows back", async () => {
    await put({ id: "a", source: "audio-gateway", machine: "Mac mini (M2 Pro)" });
    await put({ id: "b", source: "audio-gateway-mini", machine: "mini" });
    await db`SELECT usage.flag_gateway_duplicates()`;
    expect((await db`SELECT count(*)::int AS n FROM usage.records_unique`)[0]!.n).toBe(1);
    await db`DELETE FROM usage.record_duplicates`;
    expect((await db`SELECT count(*)::int AS n FROM usage.records_unique`)[0]!.n).toBe(2);
  });
});
