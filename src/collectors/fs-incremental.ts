import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Shared plumbing for collectors whose source is a tree of append-only JSONL
// files read at a per-file byte offset — claude-code's transcripts and codex's
// rollouts, and whatever comes next. Extracted after the second copy, so a
// third doesn't re-derive the "stop at the last complete line" rule and get it
// subtly wrong.

/**
 * Every `.jsonl` under `root`, at any depth.
 *
 * Walking rather than matching a known layout is deliberate: both sources nest
 * to an open-ended depth (Claude Code's subagents and workflow agents, codex's
 * YYYY/MM/DD buckets), and a layout change should not silently drop files out
 * of the numbers — which is exactly how workflow agents once went uncounted.
 */
export async function walkJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonlFiles(path)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

/**
 * The complete lines in `file` after byte `from`, plus the offset to persist.
 *
 * Returns null when there is nothing new or only a half-written trailing line
 * (a LaunchAgent tick landing mid-append) — the caller then holds its offset
 * and revisits next run, rather than parsing a truncated record.
 */
export async function readNewLines(
  file: string,
  from: number,
  size: number,
): Promise<{ lines: string[]; offset: number } | null> {
  if (size <= from) return null;

  const chunk = await Bun.file(file).slice(from, size).text();
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl === -1) return null;

  return { lines: chunk.slice(0, lastNl).split("\n"), offset: from + lastNl + 1 };
}
