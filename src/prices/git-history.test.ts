import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../pg/migrate.ts";
import { describePg, scratchDb } from "../pg/testing.ts";
import { applyHistory, gitSnapshots, type Snapshot } from "./history.ts";

// A tiny local repo standing in for BerriAI/litellm: one price file, commits at chosen UTC times.
const FILE = "model_prices_and_context_window.json";
const silent = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeRepo(commits: [iso: string, inputPerToken: number][]): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-litellm-"));
  dirs.push(dir);
  const git = (iso: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  };
  git("2026-01-01T00:00:00Z", "init", "-q", "-b", "main");
  git("2026-01-01T00:00:00Z", "config", "uploadpack.allowFilter", "true");
  git("2026-01-01T00:00:00Z", "config", "uploadpack.allowAnySHA1InWant", "true");
  for (const [iso, input] of commits) {
    writeFileSync(join(dir, FILE), JSON.stringify({ "claude-sonnet-5": { input_cost_per_token: input, output_cost_per_token: 0.00001 } }));
    git(iso, "add", FILE);
    git(iso, "commit", "-q", "-m", iso);
  }
  return `file://${dir}`;
}

async function collect(repo: string, since: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for await (const s of gitSnapshots({ repo, since, log: silent })) out.push(s);
  return out;
}

const price = (s: Snapshot) => (s.catalog["claude-sonnet-5"] as { input_cost_per_token: number }).input_cost_per_token;
const COMMITS: [string, number][] = [
  ["2026-03-20T09:00:00Z", 0.000001], // inside the 14-day lookback, but not the last commit before the start
  ["2026-03-31T10:00:00Z", 0.000002], // the baseline: last commit at or before 04-01
  ["2026-04-01T08:00:00Z", 0.000003],
  ["2026-04-01T20:00:00Z", 0.000004], // last of its UTC day wins
  ["2026-04-03T12:00:00Z", 0.000005],
];

test("baseline is the last commit before the start, stamped with the start; then one snapshot per UTC day, oldest first", async () => {
  const snaps = await collect(makeRepo(COMMITS), "2026-04-01");
  expect(snaps.map((s) => [s.date.toISOString(), price(s)])).toEqual([
    ["2026-04-01T00:00:00.000Z", 0.000002],
    ["2026-04-01T20:00:00.000Z", 0.000004],
    ["2026-04-03T12:00:00.000Z", 0.000005],
  ]);
  expect(snaps[0]?.sha).not.toBe(snaps[1]?.sha);
});

test("a start after the last commit yields just the baseline", async () => {
  const snaps = await collect(makeRepo(COMMITS), "2026-04-10");
  expect(snaps.map((s) => [s.date.toISOString(), price(s)])).toEqual([["2026-04-10T00:00:00.000Z", 0.000005]]);
});

describePg("seeded baseline", () => {
  const db = scratchDb();
  test("usage at the start is priced by the baseline, not by a later rate", async () => {
    const sql = await db.connect();
    await migrate(sql);
    await applyHistory(sql, gitSnapshots({ repo: makeRepo(COMMITS), since: "2026-04-01", log: silent }), silent);
    const cost = async (ts: string) =>
      Number((await sql`SELECT cost_usd::float8 AS c FROM usage.compute_cost('claude-sonnet-5', ${ts}::timestamptz, 1000000, 0, 0, 0, 0)`)[0].c);
    expect(await cost("2026-04-01T01:00:00Z")).toBe(2); // before the first in-window commit: baseline rate
    expect(await cost("2026-04-02T00:00:00Z")).toBe(4);
    expect(await cost("2026-04-05T00:00:00Z")).toBe(5);
    const rows = await sql`SELECT valid_from FROM usage.prices WHERE model_key = 'claude-sonnet-5' ORDER BY valid_from LIMIT 1`;
    expect(new Date(rows[0].valid_from).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});
