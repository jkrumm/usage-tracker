import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../types.ts";
import { claudeCodeCollector } from "./claude-code.ts";
import { hermesAgentCollector } from "./hermes-agent.ts";
import { litellmCollector } from "./litellm.ts";
import { opencodeCollector } from "./opencode.ts";

// The registry. Adding a source = write a collector and append it here. Paths
// are overridable via env so the registry stays machine-agnostic.
export const collectors: Collector[] = [
  claudeCodeCollector,
  hermesAgentCollector({
    source: "hermes",
    dbPath: process.env.HERMES_DB ?? join(homedir(), ".hermes", "state.db"),
    workspace: "private",
    project: "hermes-agent",
  }),
  hermesAgentCollector({
    source: "feuer",
    dbPath:
      process.env.FEUER_DB ??
      join(homedir(), "IuRoot", "prometheus-feuer-agent", "state", "hermes", "state.db"),
    // Default: read the host bind-mount via the system `sqlite3` (bun:sqlite
    // can't — it lacks FTS5 and the DB carries a `messages_fts` vtable). Set
    // FEUER_CONTAINER=feuer to force the docker-exec read instead. See README →
    // "Feuer access".
    container: process.env.FEUER_CONTAINER,
    workspace: "work",
    project: "prometheus-feuer-agent",
  }),
  opencodeCollector,
  litellmCollector,
];

export function findCollector(source: string): Collector | undefined {
  return collectors.find((c) => c.source === source);
}
