import type { Database } from "bun:sqlite";
import { claudeCodeRoots } from "./collectors/claude-code.ts";
import { walkJsonlFiles } from "./collectors/fs-incremental.ts";
import { entrypointLane, SYNTHETIC_MODEL } from "./models.ts";
import type { Billing } from "./types.ts";

/**
 * Backfill `sub_tool` (and one billing slip) on already-ingested claude-code
 * rows, using the transcript `entrypoint` the collector now stamps going
 * forward. Three defects left history wrong: interactive sessions carried a NULL
 * lane, long-lived sessions whose session_env line was pruned got a random
 * `sideclaw:*` lane from the time-window fallback, and `<synthetic>` API-error
 * rows were billed `iu` inside Max sessions.
 *
 * Changed rows get `synced_at = NULL` so the next `sync` re-pushes them, same as
 * reprice. Everything runs in one transaction. Only `source = 'claude-code'` is
 * touched, and a session whose transcript is gone (unknown entrypoint) only ever
 * has NULL rows filled from its own explicit lane.
 */

const GENERIC_LANES = new Set(["interactive", "headless", "desktop"]);

/** Bytes read first per transcript; the whole file is read only when no line in
 * this prefix carries sessionId + entrypoint (a huge pasted first message). */
const HEAD_BYTES = 256 * 1024;

function firstEntrypoint(text: string): [string, string] | null {
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { sessionId?: unknown; entrypoint?: unknown };
      if (typeof obj.sessionId === "string" && typeof obj.entrypoint === "string") return [obj.sessionId, obj.entrypoint];
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * `sessionId -> entrypoint` from the first line per file that has both fields
 * (every transcript line does). Walks both roots, subagent files included — they
 * share the parent's sessionId, and a session spans several files.
 */
export async function scanEntrypoints(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const root of claudeCodeRoots()) {
    for (const file of await walkJsonlFiles(root)) {
      const blob = Bun.file(file);
      const hit =
        firstEntrypoint(await blob.slice(0, HEAD_BYTES).text()) ??
        (blob.size > HEAD_BYTES ? firstEntrypoint(await blob.text()) : null);
      if (hit && !map.has(hit[0])) map.set(hit[0], hit[1]);
    }
  }
  return map;
}

/**
 * New `sub_tool` per row of one session, in input order (unchanged rows come
 * back as-is). The session's explicit lane is its most frequent existing lane
 * that is neither generic nor `sideclaw:*`. An agent-gateway lane is never evidence
 * for other rows: it was either stamped from the session's own session_env line
 * (then every row has it) or by the time-window fallback, which is the
 * misattribution being repaired.
 *
 * A session with an unknown entrypoint (transcript gone) that mixes NULL and
 * `sideclaw:*` rows is treated as `cli`: that mix only arises when a session
 * outlives its pruned session_env line (hours to days), and agent-gateway workers
 * finish in minutes.
 */
export function resolveSessionLanes(
  current: Array<string | null>,
  entrypoint: string | null,
): Array<string | null> {
  const isAgentGateway = (lane: string | null) => lane?.startsWith("sideclaw:") ?? false;
  const mixed = current.includes(null) && current.some(isAgentGateway);
  const effective = entrypointLane(entrypoint) === null && mixed ? "cli" : entrypoint;
  const generic = entrypointLane(effective);
  const interactive = effective === "cli" || effective === "claude-desktop";

  const counts = new Map<string, number>();
  for (const lane of current) {
    if (!lane || GENERIC_LANES.has(lane) || isAgentGateway(lane)) continue;
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  let explicit: string | null = null;
  let best = 0;
  for (const [lane, n] of counts) {
    if (n > best) {
      explicit = lane;
      best = n;
    }
  }

  return current.map((lane) => {
    if (lane === null) return explicit ?? generic;
    if (interactive && isAgentGateway(lane)) return explicit ?? generic;
    return lane;
  });
}

interface RelaneRow {
  id: number;
  session: string | null;
  sub_tool: string | null;
  model: string | null;
  billing: Billing;
  cost_usd: number | null;
}

export interface RelaneTransition {
  from: string | null;
  to: string | null;
  rows: number;
  costUsd: number;
}

export interface RelaneResult {
  scanned: number;
  /** Rows whose sub_tool and/or billing changed. */
  changed: number;
  /** `<synthetic>` rows moved from iu to max (a subset of `changed`). */
  billingFixed: number;
  /** Sessions whose transcript was not found — only NULL rows filled from their own lane. */
  unknownEntrypointSessions: number;
  dryRun: boolean;
  transitions: RelaneTransition[];
}

export function relane(
  db: Database,
  entrypoints: ReadonlyMap<string, string>,
  opts: { dryRun?: boolean } = {},
): RelaneResult {
  const dryRun = opts.dryRun ?? false;
  const rows = db
    .query<RelaneRow, []>(
      `SELECT id, json_extract(raw, '$.sessionId') AS session, sub_tool, model, billing, cost_usd
       FROM usage_record WHERE source = 'claude-code' ORDER BY id`,
    )
    .all();

  const bySession = new Map<string, RelaneRow[]>();
  for (const row of rows) {
    if (!row.session) continue;
    const group = bySession.get(row.session) ?? [];
    group.push(row);
    bySession.set(row.session, group);
  }

  const updates: Array<{ id: number; subTool: string | null; billing: Billing; entrypoint: string | null }> = [];
  const transitions = new Map<string, RelaneTransition>();
  let billingFixed = 0;
  let unknownEntrypointSessions = 0;

  for (const [session, group] of bySession) {
    const entrypoint = entrypoints.get(session) ?? null;
    if (entrypointLane(entrypoint) === null) unknownEntrypointSessions++;
    const lanes = resolveSessionLanes(
      group.map((r) => r.sub_tool),
      entrypoint,
    );
    const sessionIsMax = group.some((r) => r.model !== SYNTHETIC_MODEL && r.billing === "max");

    group.forEach((row, i) => {
      const subTool = lanes[i] ?? null;
      const fixBilling = row.model === SYNTHETIC_MODEL && row.billing === "iu" && sessionIsMax;
      if (subTool === row.sub_tool && !fixBilling) return;

      updates.push({ id: row.id, subTool, billing: fixBilling ? "max" : row.billing, entrypoint });
      if (fixBilling) billingFixed++;
      if (subTool === row.sub_tool) return;
      const key = `${row.sub_tool}\u0000${subTool}`;
      const t = transitions.get(key) ?? { from: row.sub_tool, to: subTool, rows: 0, costUsd: 0 };
      t.rows++;
      t.costUsd += row.cost_usd ?? 0;
      transitions.set(key, t);
    });
  }

  if (!dryRun && updates.length > 0) {
    // raw.entrypoint rides along when the transcript was found; json_set keeps
    // the rest of raw untouched.
    const stmt = db.prepare(
      `UPDATE usage_record
       SET sub_tool = $sub_tool, billing = $billing, synced_at = NULL,
           raw = CASE WHEN $entrypoint IS NOT NULL AND raw IS NOT NULL
                      THEN json_set(raw, '$.entrypoint', $entrypoint) ELSE raw END
       WHERE id = $id`,
    );
    db.transaction((batch: typeof updates) => {
      for (const u of batch) {
        stmt.run({ $id: u.id, $sub_tool: u.subTool, $billing: u.billing, $entrypoint: u.entrypoint });
      }
    })(updates);
  }

  return {
    scanned: rows.length,
    changed: updates.length,
    billingFixed,
    unknownEntrypointSessions,
    dryRun,
    transitions: [...transitions.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

export function formatRelane(result: RelaneResult): string {
  const label = (lane: string | null) => lane ?? "(unset)";
  const lines: string[] = [];
  if (result.transitions.length > 0) {
    lines.push(`${"from".padEnd(24)} ${"to".padEnd(16)} ${"rows".padStart(7)} ${"cost".padStart(11)}`);
    for (const t of result.transitions) {
      lines.push(
        `${label(t.from).padEnd(24)} ${label(t.to).padEnd(16)} ${String(t.rows).padStart(7)} ${t.costUsd.toFixed(4).padStart(11)}`,
      );
    }
    lines.push("");
  }
  const verb = result.dryRun ? "would relane" : "relaned";
  lines.push(
    `${verb} ${result.changed} of ${result.scanned} claude-code rows` +
      (result.billingFixed > 0 ? `, ${result.billingFixed} synthetic rows iu -> max` : "") +
      (result.dryRun ? " (dry run — nothing written)" : "; cleared synced_at so `sync` re-pushes them"),
  );
  lines.push(`${result.unknownEntrypointSessions} sessions without a transcript entrypoint (only NULL rows filled)`);
  return lines.join("\n");
}
