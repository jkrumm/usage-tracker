import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../types.ts";
import { audioProxyCollector } from "./audio-proxy.ts";
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
    // Postponed: the container read is blocked by the FTS5 `messages_fts` vtable
    // (transient sqlite connections fail "malformed"). Set FEUER_CONTAINER=feuer
    // to re-enable the docker-exec path once a working read method exists.
    // See README → "Feuer access (postponed)".
    container: process.env.FEUER_CONTAINER,
    workspace: "work",
    project: "prometheus-feuer-agent",
  }),
  opencodeCollector,
  litellmCollector,
  audioProxyCollector,
];

export function findCollector(source: string): Collector | undefined {
  return collectors.find((c) => c.source === source);
}
