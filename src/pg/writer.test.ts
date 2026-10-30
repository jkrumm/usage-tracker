import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { currentMachine } from "../machine.ts";
import { syncPrices } from "../prices/sync.ts";
import { fixtureDeps } from "../prices/testing.ts";
import type { UsageRecord } from "../types.ts";
import { migrate } from "./migrate.ts";
import { readSessionEnv, upsertSessionEnv } from "./session-env.ts";
import { describePg, scratchDb } from "./testing.ts";
import { upsertRecords } from "./writer.ts";

const T0 = new Date("2026-10-30T09:00:00Z");
const T1 = new Date("2026-10-30T10:00:00Z");
const T2 = new Date("2026-10-30T11:00:00Z");
const WED_OFF = "2026-10-28T17:17:00Z";

const rec = (sourceId: string, o: Partial<UsageRecord> = {}): UsageRecord => ({
  sourceId,
  grain: "message",
  ts: WED_OFF,
  model: "claude-sonnet-5-5",
  project: "/Users/jkrumm/SourceRoot/argo/apps/api",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  machine: "mini",
  ...o,
});

describePg("usage.records write path", () => {
  const db = scratchDb();
  // One pool for the suite (db.connect() opens a new one per call); migrated and priced on first use.
  let pool: Promise<SQL> | undefined;
  const ready = (): Promise<SQL> =>
    (pool ??= (async () => {
      const sql = await db.connect();
      await migrate(sql);
      await syncPrices(sql, fixtureDeps());
      return sql;
    })());
  const fails = async (run: () => Promise<unknown>) => {
    await expect(run()).rejects.toThrow();
  };
  const one = async (source: string, sourceId: string) => {
    const sql = await ready();
    const [row] = await sql`
      SELECT r.*, r.cost_usd::float8 AS cost, r.cost_reported_usd::float8 AS reported, s.source_session_id, s.lane AS session_lane
      FROM usage.records r LEFT JOIN usage.sessions s ON s.id = r.session_id
      WHERE r.source = ${source} AND r.source_id = ${sourceId}`;
    return row;
  };
  const session = async (source: string, id: string) => {
    const sql = await ready();
    const [row] = await sql`
      SELECT s.*, p.source_session_id AS parent
      FROM usage.sessions s LEFT JOIN usage.sessions p ON p.id = s.parent_session_id
      WHERE s.source = ${source} AND s.source_session_id = ${id}`;
    return row;
  };

  test("migrates from empty twice and creates the state and portal tables", async () => {
    const sql = await ready();
    expect((await migrate(sql)).applied).toEqual([]);
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'usage' AND table_name IN ('collector_state', 'session_env', 'iu_portal_cost', 'iu_portal_total')
      ORDER BY 1`;
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual(["collector_state", "iu_portal_cost", "iu_portal_total", "session_env"]);
    await sql`INSERT INTO usage.iu_portal_cost (day, label, "row", cost_usd, fetched_at) VALUES ('2026-10-30', 'Kimi K2.6', 3, 1.5, now())`;
    await fails(async () => {
      await sql`INSERT INTO usage.iu_portal_cost (day, label, "row", cost_usd, fetched_at) VALUES ('2026-10-30', 'Kimi K2.6', 3, 2, now())`;
    });
    await fails(async () => {
      await sql`INSERT INTO usage.iu_portal_total (month, total_usd, fetched_at) VALUES ('2026-13', 1, now())`;
    });
  }, 60_000);

  test("upserting twice leaves one row and moves ingested_at only on a real change", async () => {
    const sql = await ready();
    const r = rec("idem_1", { inputTokens: 100, outputTokens: 10, raw: { sessionId: "idem-s" } });
    expect(await upsertRecords(sql, "claude-code", [r], { now: T0 })).toEqual({ processed: 1, newRows: 1 });
    expect(await upsertRecords(sql, "claude-code", [r], { now: T1 })).toEqual({ processed: 1, newRows: 0 });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.records WHERE source_id = 'idem_1'`;
    expect(n).toBe(1);
    expect((await one("claude-code", "idem_1")).ingested_at).toEqual(T0);

    await upsertRecords(sql, "claude-code", [{ ...r, outputTokens: 11 }], { now: T2 });
    const changed = await one("claude-code", "idem_1");
    expect(changed.ingested_at).toEqual(T2);
    expect(changed.output_tokens).toBe("11");
  });

  test("machine is an attribute: the same source id from two machines is one row", async () => {
    const sql = await ready();
    await upsertRecords(sql, "claude-code", [rec("mach_1", { machine: "mini" })]);
    const summary = await upsertRecords(sql, "claude-code", [rec("mach_1", { machine: "macbook" })]);
    expect(summary.newRows).toBe(0);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.records WHERE source_id = 'mach_1'`;
    expect(n).toBe(1);
    expect((await one("claude-code", "mach_1")).machine).toBe("macbook");
    await upsertRecords(sql, "claude-code", [rec("mach_2", { machine: null })]);
    expect((await one("claude-code", "mach_2")).machine).toBe(currentMachine());
  });

  test("the five token kinds are separate, the 1h write is split out of the total", async () => {
    const sql = await ready();
    await upsertRecords(sql, "claude-code", [
      rec("tok_1", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 300, cacheWrite1hTokens: 100, reasoningTokens: 5, durationMs: 1500 }),
      rec("tok_2", { cacheWriteTokens: 40, cacheWrite1hTokens: 99 }),
      rec("tok_3", { cacheWriteTokens: 7 }),
    ]);
    expect(await one("claude-code", "tok_1")).toMatchObject({
      input_tokens: "1", output_tokens: "2", cache_read_tokens: "3", cache_write_5m_tokens: "200", cache_write_1h_tokens: "100",
      reasoning_tokens: "5", duration_ms: 1500,
    });
    // A 1h count above the total is clamped to it; a source that cannot split writes it all as 5m.
    expect(await one("claude-code", "tok_2")).toMatchObject({ cache_write_5m_tokens: "0", cache_write_1h_tokens: "40" });
    expect(await one("claude-code", "tok_3")).toMatchObject({ cache_write_5m_tokens: "7", cache_write_1h_tokens: "0" });
  });

  test("a message-grain Claude row prices all five kinds in SQL (sonnet 5.5, 1M each = 18.60)", async () => {
    const sql = await ready();
    await upsertRecords(sql, "claude-code", [
      rec("cost_1", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 2e6, cacheWrite1hTokens: 1e6 }),
    ]);
    const row = await one("claude-code", "cost_1");
    expect(row.cost).toBeCloseTo(18.6, 9);
    expect(row).toMatchObject({ cost_source: "prices", model: "claude-sonnet-5-5", model_raw: "claude-sonnet-5-5", cost_reported_usd: null });
    expect(row.price_id).not.toBeNull();
  });

  test("model_raw stays verbatim, model drops the provider prefix, date and context flag", async () => {
    await upsertRecords(await ready(), "opencode", [
      rec("model_1", { model: "Anthropic/Claude-Sonnet-5[1M]", inputTokens: 1e6 }),
      rec("model_2", { model: '{"id":"Kimi-K2.6","providerID":"iu"}', inputTokens: 1e6 }),
    ]);
    expect(await one("opencode", "model_1")).toMatchObject({ model_raw: "Anthropic/Claude-Sonnet-5[1M]", model: "claude-sonnet-5", cost_source: "prices" });
    expect(await one("opencode", "model_2")).toMatchObject({ model_raw: '{"id":"Kimi-K2.6","providerID":"iu"}', model: "kimi-k2.6" });
  });

  test("a provider-reported cost wins; sonar's is ignored and priced from tokens", async () => {
    const sql = await ready();
    await upsertRecords(sql, "agent-workflows", [
      rec("rep_1", { inputTokens: 1e6, authoritativeCostUsd: 1.234 }),
      rec("rep_2", { model: "sonar", inputTokens: 1e6, authoritativeCostUsd: 30.66 }),
      rec("rep_3", { authoritativeCostUsd: 0 }),
    ]);
    expect(await one("agent-workflows", "rep_1")).toMatchObject({ cost: 1.234, reported: 1.234, cost_source: "reported", price_id: null });
    const sonar = await one("agent-workflows", "rep_2");
    expect(sonar.reported).toBeNull();
    expect(sonar.cost_source).toBe("prices");
    expect(sonar.cost).toBeLessThan(30);
    // A stated zero is a stated cost.
    expect(await one("agent-workflows", "rep_3")).toMatchObject({ cost: 0, reported: 0, cost_source: "reported" });
  });

  test("an unknown or missing model is NULL / none, never 0", async () => {
    await upsertRecords(await ready(), "claude-code", [
      rec("none_1", { model: "claude-does-not-exist-9", inputTokens: 1e6 }),
      rec("none_2", { model: null, inputTokens: 5 }),
    ]);
    expect(await one("claude-code", "none_1")).toMatchObject({ cost: null, cost_source: "none", price_id: null });
    expect(await one("claude-code", "none_2")).toMatchObject({ cost: null, cost_source: "none", model: null, model_raw: null });
  });

  test("gpt-5.6-terra reasoning is unbilled before 2026-10-16T08:55Z: kept in raw, zero in the column", async () => {
    await upsertRecords(await ready(), "hermes", [
      rec("rf_before", { model: "gpt-5.6-terra", ts: "2026-10-16T08:54:59Z", outputTokens: 1e6, reasoningTokens: 1e6, raw: { task: null } }),
      rec("rf_after", { model: "gpt-5.6-terra", ts: "2026-10-16T08:55:00Z", outputTokens: 1e6, reasoningTokens: 1e6 }),
      rec("rf_other", { model: "gpt-5.6-luna", ts: "2026-10-01T00:00:00Z", outputTokens: 1e6, reasoningTokens: 1e6 }),
    ]);
    const before = await one("hermes", "rf_before");
    const after = await one("hermes", "rf_after");
    expect(before.reasoning_tokens).toBe("0");
    expect(before.raw).toEqual({ task: null, reasoningTokensUnbilled: 1_000_000 });
    expect(after.reasoning_tokens).toBe("1000000");
    expect(after.raw).toBeNull();
    expect(before.cost).toBeGreaterThan(0);
    expect(after.cost).toBeCloseTo(before.cost * 2, 9);
    expect((await one("hermes", "rf_other")).reasoning_tokens).toBe("1000000");
  });

  test("billing, account and key follow the record and usage.session_env", async () => {
    const sql = await ready();
    await upsertSessionEnv(sql, [
      { session: "env-iu", base_url: "https://gateway.example", lane: "agent-gateway:review", account: null },
      { session: "env-me", base_url: "", account: "b" },
    ]);
    await upsertRecords(sql, "claude-code", [
      rec("bill_max", { raw: { sessionId: "env-me" } }),
      rec("bill_iu_url", { raw: { sessionId: "env-iu" } }),
      rec("bill_iu_model", { model: "deepseek-v4-flash", raw: { sessionId: "none-seen" } }),
      rec("bill_default", { raw: { sessionId: "none-seen" } }),
    ]);
    await upsertRecords(sql, "athena-teamchat", [rec("bill_team", { model: null })]);
    await upsertRecords(sql, "hermes", [rec("bill_hermes", { grain: "session", raw: { iuKey: "athena-team" } })]);
    expect(await one("claude-code", "bill_max")).toMatchObject({ billing: "max", account: "me", api_key: null });
    expect(await one("claude-code", "bill_iu_url")).toMatchObject({ billing: "api_key", account: null, api_key: "personal" });
    expect(await one("claude-code", "bill_iu_model")).toMatchObject({ billing: "api_key", api_key: "personal" });
    expect(await one("claude-code", "bill_default")).toMatchObject({ billing: "max", account: "iu" });
    expect(await one("athena-teamchat", "bill_team")).toMatchObject({ billing: "api_key", api_key: "athena-team" });
    expect(await one("hermes", "bill_hermes")).toMatchObject({ billing: "api_key", api_key: "athena-team" });
  });

  test("repo is normalized, project_raw verbatim, workspace falls back to the collector's", async () => {
    await upsertRecords(
      await ready(),
      "hermes",
      [
        rec("repo_1", { project: "/Users/jkrumm/SourceRoot/warden-w6/src" }),
        rec("repo_2", { project: "hermes-agent", workspace: "work" }),
      ],
      { defaultWorkspace: "private" },
    );
    expect(await one("hermes", "repo_1")).toMatchObject({ repo: "warden", project_raw: "/Users/jkrumm/SourceRoot/warden-w6/src", workspace: "private" });
    expect(await one("hermes", "repo_2")).toMatchObject({ repo: null, project_raw: "hermes-agent", workspace: "work" });
  });

  test("lane, effort, issue and run pass through; lane_detail and raw stay NULL when absent", async () => {
    await upsertRecords(await ready(), "claude-code", [
      rec("pass_1", { subTool: "agent-gateway:review", raw: { sessionId: "pass-s", effort: "high", issueId: "FOO-7", runId: "run-1" } }),
      rec("pass_2", { subTool: "wave" }),
    ]);
    expect(await one("claude-code", "pass_1")).toMatchObject({
      lane: "agw_workflow", lane_detail: { workflow: "review" }, effort: "high", issue_id: "FOO-7", run_id: "run-1",
    });
    expect(await one("claude-code", "pass_2")).toMatchObject({ lane: "wave_mother", lane_detail: null, raw: null, effort: null });
  });

  test("a duplicate source id inside one call keeps the last; a bad ts is skipped", async () => {
    const sql = await ready();
    const summary = await upsertRecords(sql, "claude-code", [
      rec("dup_1", { inputTokens: 1 }),
      rec("dup_1", { inputTokens: 2 }),
      rec("bad_ts", { ts: "not a date" }),
    ]);
    expect(summary).toEqual({ processed: 3, newRows: 1 });
    expect((await one("claude-code", "dup_1")).input_tokens).toBe("2");
    expect(await one("claude-code", "bad_ts")).toBeUndefined();
  });

  test("sessions are created, widened by later batches and linked from the records", async () => {
    const sql = await ready();
    await upsertRecords(sql, "claude-code", [
      rec("ses_a1", { ts: "2026-10-29T10:05:00Z", subTool: "wave", raw: { sessionId: "ses-1", effort: "high" } }),
      rec("ses_a2", { ts: "2026-10-29T10:10:00Z", subTool: "wave", raw: { sessionId: "ses-1" } }),
      rec("ses_none", { ts: "2026-10-29T10:10:00Z" }),
    ]);
    expect(await session("claude-code", "ses-1")).toMatchObject({
      lane: "wave_mother", billing: "max", account: "iu", machine: "mini", model: "claude-sonnet-5-5", repo: "argo", effort: "high",
      first_ts: new Date("2026-10-29T10:05:00Z"), last_ts: new Date("2026-10-29T10:10:00Z"),
    });
    expect((await one("claude-code", "ses_a1")).source_session_id).toBe("ses-1");
    expect((await one("claude-code", "ses_none")).session_id).toBeNull();

    // A later batch with an earlier and a later record widens the span and fills what was missing, erasing nothing.
    await upsertRecords(sql, "claude-code", [
      rec("ses_a0", { ts: "2026-10-29T09:00:00Z", subTool: "wave", project: null, raw: { sessionId: "ses-1", issueId: "FOO-1" } }),
      rec("ses_a3", { ts: "2026-10-29T11:00:00Z", subTool: "wave", project: null, machine: "macbook", raw: { sessionId: "ses-1" } }),
    ]);
    expect(await session("claude-code", "ses-1")).toMatchObject({
      repo: "argo", effort: "high", issue_id: "FOO-1", machine: "mini",
      first_ts: new Date("2026-10-29T09:00:00Z"), last_ts: new Date("2026-10-29T11:00:00Z"),
    });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage.sessions WHERE source = 'claude-code' AND source_session_id = 'ses-1'`;
    expect(n).toBe(1);
  });

  test("a subagent record inside an interactive session keeps the session interactive, in either arrival order", async () => {
    const sql = await ready();
    const sub = { subagentType: "Explore" };
    await upsertRecords(sql, "claude-code", [
      rec("sub_i1", { ts: "2026-10-29T10:00:00Z", raw: { sessionId: "sub-ses" } }),
      rec("sub_i2", { ts: "2026-10-29T10:01:00Z", raw: { sessionId: "sub-ses", ...sub } }),
    ]);
    const record = await one("claude-code", "sub_i2");
    expect(record).toMatchObject({ lane: "subagent", lane_detail: { subagent_type: "Explore" }, session_lane: "interactive" });
    await upsertRecords(sql, "claude-code", [rec("sub_i3", { ts: "2026-10-29T09:00:00Z", raw: { sessionId: "sub-ses", ...sub } })]);
    expect((await session("claude-code", "sub-ses")).lane).toBe("interactive");

    // Seen through its subagent requests alone first, the session becomes interactive once a main record shows up.
    await upsertRecords(sql, "claude-code", [rec("sub_o1", { ts: "2026-10-29T10:00:00Z", raw: { sessionId: "sub-late", ...sub } })]);
    expect((await session("claude-code", "sub-late")).lane).toBe("subagent");
    await upsertRecords(sql, "claude-code", [rec("sub_o2", { ts: "2026-10-29T10:05:00Z", raw: { sessionId: "sub-late" } })]);
    expect((await session("claude-code", "sub-late")).lane).toBe("interactive");
  });

  test("hermes, opencode and agent-workflows rows find their sessions", async () => {
    const sql = await ready();
    await upsertRecords(sql, "hermes", [
      rec("hs_1:main:gpt-5.6-luna", { grain: "session", subTool: "cron", raw: {} }),
      rec("hs_1:title:gpt-5.6-luna", { grain: "session", subTool: "cron:title", raw: {} }),
    ]);
    expect(await session("hermes", "hs_1")).toMatchObject({ lane: "hermes", lane_detail: { surface: "cron" } });
    await upsertRecords(sql, "opencode", [
      rec("ses_oc1", { grain: "session", raw: { slug: "x" } }),
      rec("msg_oc1", { raw: { sessionId: "ses_oc1" } }),
    ]);
    expect((await one("opencode", "msg_oc1")).source_session_id).toBe("ses_oc1");
    expect((await one("opencode", "ses_oc1")).source_session_id).toBe("ses_oc1");
    await upsertRecords(sql, "agent-workflows", [
      rec("call_1", { subTool: "review:angle", raw: { runId: "run-42", issueId: "FOO-9" } }),
    ]);
    expect(await session("agent-workflows", "run-42")).toMatchObject({ lane: "agw_workflow", run_id: "run-42", issue_id: "FOO-9" });
  });

  test("a parent link resolves inside a batch and later, and is never erased", async () => {
    const sql = await ready();
    await upsertRecords(sql, "claude-code", [
      rec("par_c1", { raw: { sessionId: "par-child", parentSessionId: "par-parent" } }),
      rec("par_p1", { raw: { sessionId: "par-parent" } }),
    ]);
    expect((await session("claude-code", "par-child")).parent).toBe("par-parent");
    await upsertRecords(sql, "claude-code", [rec("par_c2", { raw: { sessionId: "par-child" } })]);
    expect((await session("claude-code", "par-child")).parent).toBe("par-parent");

    // The parent arrives after the child: the next batch that mentions the link resolves it.
    await upsertRecords(sql, "claude-code", [rec("par_o1", { raw: { sessionId: "orphan", parentSessionId: "later" } })]);
    expect((await session("claude-code", "orphan")).parent).toBeNull();
    await upsertRecords(sql, "claude-code", [rec("par_l1", { raw: { sessionId: "later" } })]);
    await upsertRecords(sql, "claude-code", [rec("par_o2", { raw: { sessionId: "orphan", parentSessionId: "later" } })]);
    expect((await session("claude-code", "orphan")).parent).toBe("later");
  });

  test("session_env helpers: the newest line wins, a missing account never erases a stored one", async () => {
    const sql = await ready();
    await upsertSessionEnv(sql, [{ session: "se-1", base_url: "https://a.example", lane: "wave", account: "a" }], T0);
    await upsertSessionEnv(sql, [{ session: "se-1", base_url: "", lane: null }], T1);
    const env = await readSessionEnv(sql, ["se-1", "se-absent"]);
    expect([...env.keys()]).toEqual(["se-1"]);
    expect(env.get("se-1")).toMatchObject({ base_url: "", lane: null, account: "iu", seen_at: T1 });
  });

  test("concurrent writers of overlapping batches converge without errors", async () => {
    const sql = await ready();
    const batch = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => rec(`conc_${from + i}`, { inputTokens: from + i, raw: { sessionId: `conc-s${(from + i) % 7}` } }));
    const results = await Promise.all([
      upsertRecords(sql, "claude-code", batch(0, 300)),
      upsertRecords(sql, "claude-code", batch(150, 450)),
      upsertRecords(sql, "claude-code", batch(0, 450)),
    ]);
    expect(results.reduce((n, r) => n + r.newRows, 0)).toBe(450);
    const [{ n, s }] = await sql`
      SELECT count(*)::int AS n, count(DISTINCT session_id)::int AS s FROM usage.records WHERE source_id LIKE 'conc\\_%'`;
    expect(n).toBe(450);
    expect(s).toBe(7);
  });

  test("a 5k-row batch with sessions completes in a few seconds", async () => {
    const sql = await ready();
    const rows = Array.from({ length: 5000 }, (_, i) =>
      rec(`bulk_${i}`, {
        ts: new Date(Date.parse("2026-10-20T00:00:00Z") + i * 60_000).toISOString(),
        model: i % 3 === 0 ? "claude-opus-5-5" : "claude-sonnet-5-5",
        inputTokens: 1000 + i,
        outputTokens: 200,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 4000,
        cacheWrite1hTokens: 1000,
        raw: { sessionId: `bulk-s${i % 120}` },
      }),
    );
    const started = performance.now();
    const summary = await upsertRecords(sql, "claude-code", rows);
    const seconds = (performance.now() - started) / 1000;
    expect(summary).toEqual({ processed: 5000, newRows: 5000 });
    expect(seconds).toBeLessThan(15);
    const [{ n, s, priced }] = await sql`
      SELECT count(*)::int AS n, count(DISTINCT session_id)::int AS s, count(cost_usd)::int AS priced
      FROM usage.records WHERE source_id LIKE 'bulk\\_%'`;
    expect([n, s, priced]).toEqual([5000, 120, 5000]);
    // The unchanged re-run is cheap and writes nothing.
    const again = await upsertRecords(sql, "claude-code", rows);
    expect(again.newRows).toBe(0);
  }, 60_000);
});
