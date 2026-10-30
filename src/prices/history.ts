import type { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log as defaultLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { ALIASES, upsertAliases } from "./aliases.ts";
import type { PriceRow } from "./cost.ts";
import { droppedRate, normalizeLiteLLM, scheduleText } from "./normalize.ts";
import { insertPrice, loadTimelines } from "./store.ts";
import { OPENROUTER_PREFIX } from "./sync.ts";

// One-off history seed (decision U3: no catalog publishes history, so git is the source). LiteLLM's price file
// is read at the last commit of each UTC day, oldest first, and a prices row is written per aliased model only
// when its schedule differs from the one in force on that day. Idempotent: valid_from is the commit time, so a
// re-run finds every row already there.

export const LITELLM_REPO = "https://github.com/BerriAI/litellm.git";
const FILE = "model_prices_and_context_window.json";
export const DEFAULT_SINCE = "2026-04-01";
export const MAX_CLONE_BYTES = 600 * 1024 * 1024;

export interface Snapshot {
  sha: string;
  date: Date;
  catalog: Record<string, unknown>;
}
export interface SeedResult {
  snapshots: number;
  inserted: number;
  skipped: number;
}

/** Walk the snapshots (oldest first) and write the changes for every aliased LiteLLM key. */
export async function applyHistory(sql: SQL, snapshots: AsyncIterable<Snapshot>, log: Logger = defaultLog): Promise<SeedResult> {
  await upsertAliases(sql);
  const keys = [...new Set(ALIASES.map((a) => a.modelKey))].filter((k) => !k.startsWith(OPENROUTER_PREFIX));
  const timelines = await loadTimelines(sql, keys);
  const result: SeedResult = { snapshots: 0, inserted: 0, skipped: 0 };

  for await (const snap of snapshots) {
    result.snapshots++;
    for (const key of keys) {
      const timeline = timelines.get(key) as PriceRow[];
      const inForce = [...timeline].reverse().find((r) => r.validFrom <= snap.date);
      const next = normalizeLiteLLM(snap.catalog[key]);
      // A snapshot where the key is missing or unusable says nothing; the previous schedule stands.
      if (!next || (inForce && droppedRate(inForce.schedule, next))) {
        result.skipped++;
        continue;
      }
      if (inForce && scheduleText(inForce.schedule) === scheduleText(next)) continue;
      const written = await insertPrice(sql, {
        modelKey: key,
        validFrom: snap.date,
        schedule: next,
        source: "seed-git",
        sourceRef: snap.sha,
        fetchedAt: new Date(),
      });
      if (!written) continue;
      result.inserted++;
      timeline.push({ id: 0, modelKey: key, validFrom: snap.date, schedule: next });
      timeline.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
    }
  }
  log.info(`prices-seed-history: ${result.snapshots} snapshots, ${result.inserted} rows written, ${result.skipped} model/day skipped`);
  return result;
}

async function dirBytes(dir: string): Promise<number> {
  const du = Bun.spawnSync(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
  return Number.parseInt(du.stdout.toString(), 10) * 1024 || 0;
}

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", maxBuffer: 64 * 1024 * 1024 });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${p.stderr.toString().trim().slice(0, 300)}`);
  return p.stdout.toString();
}

/** How far before the period start the clone reaches to find the baseline commit. */
const BASELINE_LOOKBACK_DAYS = 14;

/**
 * Blobless, history-limited clone of LiteLLM into a temp dir outside the repo, then the file as of the period
 * start (the last commit at or before it, stamped with the start itself, so usage from the start on never falls
 * back to a later rate) and at the last commit of each UTC day from the start. Oldest first. The clone is killed
 * and the run aborted when the temp dir passes maxBytes.
 */
export async function* gitSnapshots(
  opts: { since?: string; maxBytes?: number; log?: Logger; repo?: string } = {},
): AsyncGenerator<Snapshot> {
  const since = opts.since ?? DEFAULT_SINCE;
  const maxBytes = opts.maxBytes ?? MAX_CLONE_BYTES;
  const log = opts.log ?? defaultLog;
  const repo = opts.repo ?? LITELLM_REPO;
  const start = new Date(`${since}T00:00:00Z`);
  const dir = await mkdtemp(join(tmpdir(), "litellm-history-"));
  try {
    const shallowSince = new Date(start.getTime() - BASELINE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    log.info(`prices-seed-history: cloning ${repo} (blobless, since ${shallowSince}) into ${dir}`);
    const clone = Bun.spawn(
      ["git", "clone", "--filter=blob:none", "--no-checkout", "--single-branch", `--shallow-since=${shallowSince}`, repo, dir],
      { stdout: "ignore", stderr: "ignore" },
    );
    let aborted = false;
    const watch = setInterval(async () => {
      if ((await dirBytes(dir)) > maxBytes) {
        aborted = true;
        clone.kill();
      }
    }, 2000);
    const code = await clone.exited;
    clearInterval(watch);
    if (aborted) throw new Error(`clone exceeded ${Math.round(maxBytes / 1024 / 1024)} MB; aborted`);
    if (code !== 0) throw new Error(`git clone exited ${code}`);

    const read = (sha: string) => JSON.parse(git(dir, "show", `${sha}:${FILE}`)) as Record<string, unknown>;
    const assertBudget = async () => {
      if ((await dirBytes(dir)) > maxBytes) throw new Error(`blob fetches exceeded ${Math.round(maxBytes / 1024 / 1024)} MB; aborted`);
    };

    const baseline = git(dir, "log", "-1", "--format=%H", `--until=${start.toISOString()}`, "--", FILE).trim();
    if (baseline) yield { sha: baseline, date: start, catalog: read(baseline) };
    else log.warn(`prices-seed-history: no commit of ${FILE} at or before ${since} within ${BASELINE_LOOKBACK_DAYS} days; no baseline row`);

    const lines = git(dir, "log", "--format=%H %cI", `--since=${start.toISOString()}`, "--", FILE).trim().split("\n").filter(Boolean);
    const lastOfDay = new Map<string, { sha: string; date: Date }>();
    for (const line of lines) {
      const [sha = "", iso = ""] = line.split(" ");
      const date = new Date(iso);
      const day = date.toISOString().slice(0, 10);
      const seen = lastOfDay.get(day);
      if (!seen || date > seen.date) lastOfDay.set(day, { sha, date });
    }
    const days = [...lastOfDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    log.info(`prices-seed-history: ${days.length} daily snapshots of ${FILE}`);

    for (const { sha, date } of days) {
      await assertBudget();
      yield { sha, date, catalog: read(sha) };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
