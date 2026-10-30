import { expect, test } from "bun:test";
import { chooseRow, monthOf, pickArgoRow, storedBilling, storedGrain, toRecord, type StoredRow } from "./backfill.ts";

const row = (o: Partial<StoredRow> = {}): StoredRow => ({
  source: "claude-code",
  sourceId: "r1",
  grain: "message",
  ts: "2026-10-01T10:00:00.000Z",
  model: "claude-sonnet-5-5",
  modelNorm: "claude-sonnet-5-5",
  project: "/Users/x/SourceRoot/argo",
  billing: "max",
  machine: "Mac mini (M2 Pro)",
  outcome: "ok",
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 40,
  cacheWrite1hTokens: 10,
  reasoningTokens: 0,
  costUsd: 0.5,
  costSource: "computed",
  raw: '{"sessionId":"s1"}',
  ingestedAt: "2026-10-01 10:05:00",
  subTool: null,
  durationMs: null,
  workspace: null,
  account: "iu",
  iuKey: null,
  ...o,
});

test("a stored row maps to a record with preclassified values and the 1h split", () => {
  const m = toRecord(row());
  if ("skip" in m) throw new Error("skipped");
  expect(m.record).toMatchObject({
    sourceId: "r1",
    grain: "message",
    cacheWriteTokens: 40,
    cacheWrite1hTokens: 10,
    raw: { sessionId: "s1" },
    authoritativeCostUsd: undefined,
    preclassified: { billing: "max", account: "iu", iuKey: null, machine: "Mac mini (M2 Pro)" },
  });
});

test("only cost_source reported passes its cost on as the provider-reported cost", () => {
  const reported = toRecord(row({ costSource: "reported", costUsd: 0.25 }));
  const zero = toRecord(row({ costSource: "reported", costUsd: 0 }));
  const family = toRecord(row({ costSource: "family", costUsd: 0.25 }));
  const none = toRecord(row({ costSource: "reported", costUsd: null }));
  expect((reported as { record: { authoritativeCostUsd?: number } }).record.authoritativeCostUsd).toBe(0.25);
  expect((zero as { record: { authoritativeCostUsd?: number } }).record.authoritativeCostUsd).toBe(0);
  expect((family as { record: { authoritativeCostUsd?: number } }).record.authoritativeCostUsd).toBeUndefined();
  expect((none as { record: { authoritativeCostUsd?: number } }).record.authoritativeCostUsd).toBeUndefined();
});

test("legacy grains and billing classes map into the writer's vocabulary", () => {
  expect(storedGrain("request")).toBe("message");
  expect(storedGrain("step")).toBe("session");
  expect(storedGrain("message")).toBe("message");
  expect(storedGrain("nonsense")).toBeNull();
  expect(storedBilling("openrouter")).toBe("unknown");
  expect(storedBilling("anthropic-api")).toBe("anthropic-api");
  expect(storedBilling("iu")).toBe("iu");
});

test("an unparseable ts or unknown grain is skipped with the offending value, not mapped", () => {
  expect(toRecord(row({ ts: "yesterday" }))).toEqual({ skip: "ts", detail: "yesterday" });
  expect(toRecord(row({ grain: "burst" }))).toEqual({ skip: "grain", detail: "burst" });
});

test("raw: Argo's parsed object passes through, a malformed or non-object value is flagged", () => {
  expect((toRecord(row({ raw: { a: 1 } })) as { record: { raw: unknown } }).record.raw).toEqual({ a: 1 });
  expect(toRecord(row({ raw: "{nope" }))).toMatchObject({ malformedRaw: true, record: { raw: undefined } });
  expect(toRecord(row({ raw: "[1,2]" }))).toMatchObject({ malformedRaw: true, record: { raw: { legacyRaw: [1, 2] } } });
  expect(toRecord(row({ raw: null }))).toMatchObject({ malformedRaw: false, record: { raw: undefined } });
});

test("an empty machine stays NULL through preclassified, a workspace outside work/private is dropped", () => {
  const m = toRecord(row({ machine: null, workspace: "elsewhere", outcome: "error" })) as { record: { preclassified: { machine: unknown }; workspace: unknown; outcome: string } };
  expect(m.record.preclassified.machine).toBeNull();
  expect(m.record.workspace).toBeUndefined();
  expect(m.record.outcome).toBe("error");
});

test("of several Argo rows the one on SQLite's machine wins, else the latest ingested, else the highest id", () => {
  const a = row({ id: 1, machine: "mini", ingestedAt: "2026-10-01 10:00:00" });
  const b = row({ id: 2, machine: "vps", ingestedAt: "2026-10-02 10:00:00" });
  const c = row({ id: 3, machine: "Mac mini (M2 Pro)", ingestedAt: "2026-10-01 09:00:00" });
  expect(pickArgoRow([a, b, c], "Mac mini (M2 Pro)")).toBe(c);
  expect(pickArgoRow([c, b, a], "Mac mini (M2 Pro)")).toBe(c);
  expect(pickArgoRow([a, b], null)).toBe(b);
  expect(pickArgoRow([b, a], "elsewhere")).toBe(b);
  const d = row({ id: 9, machine: "x", ingestedAt: "2026-10-02 10:00:00" });
  expect(pickArgoRow([b, d], null)).toBe(d);
  expect(pickArgoRow([d, b], null)).toBe(d);
});

test("SQLite wins a shared key and borrows what it left empty; duplicates are counted, not merged", () => {
  const sqlite = row({ workspace: null, subTool: null, costUsd: 0.123456789 });
  const argoA = row({ id: 1, workspace: "private", subTool: "check", costUsd: 0.12345679, machine: "mini", cacheWrite1hTokens: 0 });
  const argoB = row({ id: 2, workspace: "work", machine: "vps", ingestedAt: "2026-10-03 00:00:00" });
  const c = chooseRow([argoA, argoB], sqlite);
  expect(c?.origin).toBe("sqlite");
  expect(c?.row.costUsd).toBe(0.123456789);
  expect(c?.row.cacheWrite1hTokens).toBe(10);
  expect(c?.argo).toBe(argoB);
  expect(c?.row.workspace).toBe("work");
  expect(c?.borrowed).toEqual(["workspace"]);
  expect(c?.dropped).toEqual([argoA]);
});

test("an Argo-only key is written from Argo, and a SQLite-only key from SQLite", () => {
  const a = row({ id: 1 });
  expect(chooseRow([a], undefined)).toMatchObject({ origin: "argo", row: a, dropped: [] });
  expect(chooseRow([], a)).toMatchObject({ origin: "sqlite", argo: null });
  expect(chooseRow([], undefined)).toBeNull();
});

test("the month of a timestamp is its UTC calendar month", () => {
  expect(monthOf("2026-10-31T23:59:59Z")).toBe("2026-10");
  expect(monthOf("2026-11-01T00:30:00+01:00")).toBe("2026-10");
});
