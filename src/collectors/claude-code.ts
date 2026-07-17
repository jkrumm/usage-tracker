import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isBridgeRouted } from "../models.ts";
import type { Collector, CollectContext, CollectResult, UsageRecord } from "../types.ts";

// Claude Code writes one JSONL file per session under ~/.claude/projects/.
// Files are append-only, so we resume each by byte offset (advancing only to the
// last complete line) and dedup on requestId. This is the only large source —
// ~370MB across hundreds of files — so incremental reads matter.

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface AssistantLine {
  type?: string;
  requestId?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      service_tier?: string;
    };
  };
}

type Offsets = Record<string, number>;

export const claudeCodeCollector: Collector = {
  source: "claude-code",

  available() {
    return existsSync(PROJECTS_DIR);
  },

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const offsets: Offsets = ctx.full ? {} : parseOffsets(ctx.cursor);
    const files = await listJsonl(PROJECTS_DIR);
    const records: UsageRecord[] = [];

    for (const file of files) {
      const size = statSync(file).size;
      const from = offsets[file] ?? 0;
      if (size <= from) continue;

      const chunk = await Bun.file(file).slice(from, size).text();
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl === -1) continue; // no complete line yet; revisit next run

      const complete = chunk.slice(0, lastNl);
      for (const line of complete.split("\n")) {
        const rec = parseLine(line);
        if (rec) records.push(rec);
      }
      offsets[file] = from + lastNl + 1;
    }

    return { records, cursor: JSON.stringify(offsets) };
  },
};

function parseLine(line: string): UsageRecord | null {
  if (!line) return null;
  let obj: AssistantLine;
  try {
    obj = JSON.parse(line) as AssistantLine;
  } catch {
    return null;
  }

  const usage = obj.message?.usage;
  if (obj.type !== "assistant" || !usage) return null;
  if (obj.message?.model === "<synthetic>") return null; // local, non-API message

  const model = obj.message?.model ?? null;
  // Keep Max-subscription Claude sessions AND IU-direct sessions (ca launcher
  // going direct to the IU Anthropic endpoint — no bridge, so no litellm
  // double-count). Skip bridge-routed sessions: those are already counted
  // per-request by the litellm source.
  if (isBridgeRouted(model)) return null;

  const sourceId = obj.requestId ?? obj.uuid ?? `${obj.sessionId}:${obj.message?.id}`;
  if (!sourceId) return null;

  return {
    sourceId,
    grain: "message",
    ts: obj.timestamp ?? new Date().toISOString(),
    model: obj.message?.model ?? null,
    project: obj.cwd ?? null,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    reasoningTokens: 0,
    raw: {
      sessionId: obj.sessionId,
      messageId: obj.message?.id,
      serviceTier: usage.service_tier,
    },
  };
}

function parseOffsets(cursor: string | null): Offsets {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor) as Offsets;
  } catch {
    return {};
  }
}

async function listJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  const dirs = await readdir(root, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projectDir = join(root, d.name);
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(projectDir, e.name));
      if (e.isDirectory()) {
        const subagentsDir = join(projectDir, e.name, "subagents");
        if (!existsSync(subagentsDir)) continue;
        const subEntries = await readdir(subagentsDir, { withFileTypes: true });
        for (const s of subEntries) {
          if (s.isFile() && s.name.endsWith(".jsonl")) out.push(join(subagentsDir, s.name));
        }
      }
    }
  }
  return out;
}
