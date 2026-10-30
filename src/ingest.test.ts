import type { SQL } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astraCollector } from "./collectors/astra.ts";
import { claudeCodeCollector } from "./collectors/claude-code.ts";
import { codexCollector } from "./collectors/codex.ts";
import { formatRunSummary, runIngest } from "./ingest.ts";
import { resetAgentGatewayWindowsCacheForTest, resetSessionBaseUrlsCacheForTest } from "./models.ts";
import { migratedDb } from "./pg/fixture.ts";
import { describePg } from "./pg/testing.ts";
import type { SyncResult } from "./remote.ts";
import type { Collector, UsageRecord } from "./types.ts";

process.env.USAGE_MACHINE = "Test Machine (Override)";

const ENV_KEYS = [
  "USAGE_CLAUDE_PROJECTS_DIR",
  "USAGE_CLAUDE_LOGS_DIR",
  "USAGE_CODEX_SESSIONS_DIR",
  "USAGE_ASTRA_DIR",
  "USAGE_REMOTE_DIR",
  "AGENT_GATEWAY_SESSIONS_USAGE_LOG",
] as const;

const ok: SyncResult = { ok: true, logsOk: true, codexOk: true, usageJsonlOk: true };

const rec = (sourceId: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
  sourceId,
  grain: "message",
  ts: "2026-10-30T10:00:00.000Z",
  model: "claude-sonnet-5",
  project: null,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...over,
});

/** A collector replaying `records` that persists `cursor`, and remembers the cursor it was handed. */
function fake(source: string, records: UsageRecord[], cursor: string | null, seen: Array<string | null> = []): Collector {
  return {
    source,
    staleAfterHours: null,
    available: () => true,
    async collect(ctx) {
      seen.push(ctx.cursor);
      return { records, cursor };
    },
  };
}

describePg("runIngest (Postgres)", () => {
  const pg = migratedDb();
  let sql: SQL;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    sql = await pg.reset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "usage-tracker-ingest-"));
    mkdirSync(join(dir, "claude-projects"));
    mkdirSync(join(dir, "claude-logs"));
    mkdirSync(join(dir, "codex-sessions"));
    writeFileSync(join(dir, "astra.jsonl"), "");
    process.env.USAGE_CLAUDE_PROJECTS_DIR = join(dir, "claude-projects");
    process.env.USAGE_CLAUDE_LOGS_DIR = join(dir, "claude-logs");
    process.env.USAGE_CODEX_SESSIONS_DIR = join(dir, "codex-sessions");
    process.env.USAGE_ASTRA_DIR = dir;
    process.env.USAGE_REMOTE_DIR = join(dir, "remote");
    process.env.AGENT_GATEWAY_SESSIONS_USAGE_LOG = join(dir, "no-such-sessions.jsonl");
    resetSessionBaseUrlsCacheForTest();
    resetAgentGatewayWindowsCacheForTest();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetSessionBaseUrlsCacheForTest();
    resetAgentGatewayWindowsCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const state = async (source: string) => {
    const [row] = await sql`
      SELECT cursor, last_status, last_note, records_total::int AS total, last_run_at IS NOT NULL AS ran
      FROM usage.collector_state WHERE source = ${source}`;
    return row;
  };

  test("syncs the mirror once per pass, and again on the next pass", async () => {
    let calls = 0;
    const opts = {
      collectors: [claudeCodeCollector, codexCollector, astraCollector],
      syncIumac: async () => {
        calls++;
        return ok;
      },
    };

    const first = await runIngest(sql, opts);
    expect(first.results.map((r) => r.source)).toEqual(["claude-code", "codex", "astra"]);
    expect(first.results.every((r) => r.status !== "skipped")).toBe(true);
    expect(calls).toBe(1);

    await runIngest(sql, opts);
    expect(calls).toBe(2);
  });

  test("records land, a second run adds none, the cursor round-trips and the bookkeeping is kept", async () => {
    const seen: Array<string | null> = [];
    const collector = fake("fake-a", [rec("a1"), rec("a2")], "offset-1", seen);

    const first = await runIngest(sql, { collectors: [collector] });
    expect(first.results).toEqual([{ source: "fake-a", status: "ok", processed: 2, newRows: 2, note: undefined }]);
    expect(await state("fake-a")).toMatchObject({ cursor: "offset-1", last_status: "ok", total: 2, ran: true });

    const second = await runIngest(sql, { collectors: [collector] });
    expect(second.results[0]).toMatchObject({ status: "ok", processed: 2, newRows: 0 });
    expect(seen).toEqual([null, "offset-1"]);

    await runIngest(sql, { collectors: [collector], full: true });
    expect(seen.at(-1)).toBeNull();
    expect(Number((await sql`SELECT count(*)::int AS n FROM usage.records`)[0].n)).toBe(2);
  });

  test("an erroring collector is recorded, keeps its cursor and does not stop the others", async () => {
    const boom: Collector = {
      source: "boom",
      staleAfterHours: null,
      available: () => true,
      async collect() {
        throw new Error("store moved");
      },
    };
    await runIngest(sql, { collectors: [fake("boom", [rec("b0")], "kept-cursor")] });

    const summary = await runIngest(sql, { collectors: [boom, fake("fake-b", [rec("b1")], "c")] });
    expect(summary.results.map((r) => [r.source, r.status])).toEqual([["boom", "error"], ["fake-b", "ok"]]);
    expect(await state("boom")).toMatchObject({ cursor: "kept-cursor", last_status: "error", last_note: "store moved", total: 1 });
    expect(await state("fake-b")).toMatchObject({ last_status: "ok", total: 1 });
    expect(formatRunSummary(summary)).toMatch(/status=error boom=error fake-b=\+1\/1 quota=\+0 picks=\+0 portal=\+0 unpriced=\d+$/);
  });

  test("a state store that fails with the collector does not abort the other collectors or the run summary", async () => {
    const boom: Collector = {
      source: "boom-db",
      staleAfterHours: null,
      available: () => true,
      async collect() {
        throw new Error("connection terminated");
      },
    };
    // Postgres "dropped" for the bookkeeping of one source only: every write of its collector_state row fails.
    await sql.unsafe(`
      CREATE FUNCTION pg_temp_state_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'state store down'; END $$;
      CREATE TRIGGER state_fail BEFORE INSERT OR UPDATE ON usage.collector_state
        FOR EACH ROW WHEN (NEW.source = 'boom-db') EXECUTE FUNCTION pg_temp_state_fail()`);
    try {
      const summary = await runIngest(sql, { collectors: [boom, fake("after-boom", [rec("ab1")], "c")] });
      expect(summary.results.map((r) => [r.source, r.status])).toEqual([["boom-db", "error"], ["after-boom", "ok"]]);
      expect(await state("after-boom")).toMatchObject({ last_status: "ok", cursor: "c", total: 1 });
      expect(formatRunSummary(summary)).toMatch(/status=error boom-db=error after-boom=\+1\/1 quota=\+0 picks=\+0 portal=\+0 unpriced=\d+$/);
    } finally {
      await sql.unsafe("DROP TRIGGER state_fail ON usage.collector_state; DROP FUNCTION pg_temp_state_fail()");
    }
  });

  test("the portal pass still runs after a collector whose state could not be saved", async () => {
    const boom: Collector = {
      source: "boom-db",
      staleAfterHours: null,
      available: () => true,
      async collect() {
        throw new Error("connection terminated");
      },
    };
    await sql.unsafe(`
      CREATE FUNCTION pg_temp_state_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'state store down'; END $$;
      CREATE TRIGGER state_fail BEFORE INSERT OR UPDATE ON usage.collector_state
        FOR EACH ROW WHEN (NEW.source = 'boom-db') EXECUTE FUNCTION pg_temp_state_fail()`);
    let fetched = 0;
    try {
      await runIngest(sql, {
        collectors: [boom],
        accounts: false,
        portal: true,
        portalFetch: async () => {
          fetched++;
          return { code: 1, stdout: "", stderr: "stub" };
        },
      });
    } finally {
      await sql.unsafe("DROP TRIGGER state_fail ON usage.collector_state; DROP FUNCTION pg_temp_state_fail()");
    }
    expect(fetched).toBeGreaterThan(0);
  });

  test("a note without records is skipped, an unavailable collector never runs", async () => {
    const quiet: Collector = {
      source: "quiet",
      staleAfterHours: null,
      available: () => true,
      collect: async () => ({ records: [], cursor: null, note: "nothing to read" }),
    };
    const absent: Collector = { ...fake("absent", [rec("x")], null), available: () => false };
    const summary = await runIngest(sql, { collectors: [quiet, absent] });
    expect(summary.results.map((r) => [r.source, r.status])).toEqual([["quiet", "skipped"], ["absent", "skipped"]]);
    expect(await state("quiet")).toMatchObject({ last_status: "skipped", last_note: "nothing to read" });
    expect(await state("absent")).toBeUndefined();
    await expect(runIngest(sql, { only: "nope", collectors: [quiet] })).rejects.toThrow('unknown source "nope"');
  });

  test("the collector workspace is stamped on its rows", async () => {
    await runIngest(sql, { collectors: [{ ...fake("ws", [rec("w1", { model: "kimi-k2.6" })], null), workspace: "work" }] });
    const [row] = await sql`SELECT workspace, billing FROM usage.records WHERE source = 'ws'`;
    expect(row).toMatchObject({ workspace: "work", billing: "api_key" });
  });

  const transcript = (session: string, requestId: string, model = "claude-sonnet-5") =>
    `${JSON.stringify({
      type: "assistant",
      requestId,
      sessionId: session,
      timestamp: new Date().toISOString(),
      cwd: "/Users/jkrumm/SourceRoot/argo",
      entrypoint: "cli",
      message: { id: `msg-${requestId}`, model, usage: { input_tokens: 10, output_tokens: 5 } },
    })}\n`;
  const hookLine = (data: Record<string, unknown>) => `${JSON.stringify({ event: "session_env", data })}\n`;
  const collectors = () => [claudeCodeCollector];
  const opts = () => ({ collectors: collectors(), syncIumac: async () => ok });
  const row = async (requestId: string) => {
    const [r] = await sql`
      SELECT r.billing, r.account, r.api_key, r.lane, s.lane AS session_lane
      FROM usage.records r JOIN usage.sessions s ON s.id = r.session_id
      WHERE r.source = 'claude-code' AND r.source_id = ${requestId}`;
    return r;
  };

  test("a hook-log line sets billing, account and lane of the session's claude-code records", async () => {
    writeFileSync(
      join(dir, "claude-logs", "2026-10-30.jsonl"),
      hookLine({ session: "s-wave", base_url: "", lane: "wave", account: "me" }) +
        hookLine({ session: "s-ca", base_url: "https://iu.example", lane: null, account: "me" }) +
        hookLine({ session: "s-old", base_url: "", lane: null }),
    );
    writeFileSync(join(dir, "claude-projects", "a.jsonl"), transcript("s-wave", "r1") + transcript("s-ca", "r2") + transcript("s-old", "r3") + transcript("s-none", "r4"));

    await runIngest(sql, opts());

    expect(await row("r1")).toMatchObject({ billing: "max", account: "me", lane: "wave_mother", session_lane: "wave_mother" });
    expect(await row("r2")).toMatchObject({ billing: "api_key", account: null, api_key: "personal" });
    // no account on the line = the IU account; no line at all = max/iu with the entrypoint lane
    expect(await row("r3")).toMatchObject({ billing: "max", account: "iu", lane: "interactive" });
    expect(await row("r4")).toMatchObject({ billing: "max", account: "iu", lane: "interactive" });
    const stored = await sql`SELECT session, base_url, lane, account FROM usage.session_env ORDER BY session`;
    expect(stored.map((s: Record<string, unknown>) => [s.session, s.base_url, s.lane, s.account])).toEqual([
      ["s-ca", "https://iu.example", null, "me"],
      ["s-old", "", null, null],
      ["s-wave", "", "wave", "me"],
    ]);
  });

  test("a session keeps its lane, base_url and account after the log file is pruned", async () => {
    const log = join(dir, "claude-logs", "2026-10-30.jsonl");
    writeFileSync(log, hookLine({ session: "s-ca", base_url: "https://iu.example", lane: "fan", account: "me2" }));
    writeFileSync(join(dir, "claude-projects", "a.jsonl"), transcript("s-ca", "r1"));
    await runIngest(sql, opts());
    expect(await row("r1")).toMatchObject({ billing: "api_key", lane: "fan_worker" });

    rmSync(log);
    resetSessionBaseUrlsCacheForTest();
    writeFileSync(join(dir, "claude-projects", "b.jsonl"), transcript("s-ca", "r2"));
    await runIngest(sql, opts());
    expect(await row("r2")).toMatchObject({ billing: "api_key", api_key: "personal", lane: "fan_worker" });
  });

  test("a later line without an account keeps the stored account; a changed line replaces lane and base_url", async () => {
    const log = join(dir, "claude-logs", "2026-10-30.jsonl");
    writeFileSync(log, hookLine({ session: "s", base_url: "", lane: "wave", account: "me" }));
    writeFileSync(join(dir, "claude-projects", "a.jsonl"), transcript("s", "r1"));
    await runIngest(sql, opts());

    writeFileSync(log, hookLine({ session: "s", base_url: "", lane: "bg" }));
    resetSessionBaseUrlsCacheForTest();
    writeFileSync(join(dir, "claude-projects", "b.jsonl"), transcript("s", "r2"));
    await runIngest(sql, opts());

    expect(await row("r2")).toMatchObject({ billing: "max", account: "me" });
    const [stored] = await sql`SELECT lane, account FROM usage.session_env WHERE session = 's'`;
    expect(stored).toMatchObject({ lane: "bg", account: "me" });
  });

  test("an unchanged log is not rewritten on the next run", async () => {
    writeFileSync(join(dir, "claude-logs", "2026-10-30.jsonl"), hookLine({ session: "s", base_url: "", lane: "wave", account: "me" }));
    writeFileSync(join(dir, "claude-projects", "a.jsonl"), transcript("s", "r1"));
    await runIngest(sql, opts());
    const [before] = await sql`SELECT seen_at FROM usage.session_env WHERE session = 's'`;
    await runIngest(sql, opts());
    const [after] = await sql`SELECT seen_at FROM usage.session_env WHERE session = 's'`;
    expect(new Date(after.seen_at).getTime()).toBe(new Date(before.seen_at).getTime());
  });
});
