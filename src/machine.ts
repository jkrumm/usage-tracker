import { hostname } from "node:os";

// The DB is local per machine; the eventual Argo sync merges several laptops'
// DBs into one view. Tagging every row with the host that produced it keeps
// those rows distinguishable after the merge. Derived once per ingest run.

let cached: string | null = null;

/**
 * Stable label for the machine that produced a record. `USAGE_MACHINE` wins;
 * otherwise the macOS hardware model + chip (e.g. "Mac mini (M2 Pro)"), falling
 * back to the network hostname when that can't be read.
 */
export function currentMachine(): string {
  if (cached !== null) return cached;
  cached = process.env.USAGE_MACHINE?.trim() || derive();
  return cached;
}

function derive(): string {
  if (process.platform === "darwin") {
    const model = macModel();
    if (model) return model;
  }
  return hostname();
}

function macModel(): string | null {
  try {
    const proc = Bun.spawnSync(["system_profiler", "SPHardwareDataType"]);
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString();
    const name = /Model Name:\s*(.+)/.exec(out)?.[1]?.trim();
    const chip = /Chip:\s*(.+)/
      .exec(out)?.[1]
      ?.trim()
      .replace(/^Apple\s+/, "");
    if (name && chip) return `${name} (${chip})`;
    return name ?? null;
  } catch {
    return null;
  }
}
