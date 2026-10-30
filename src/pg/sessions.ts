import type { Lane, LaneDetail } from "../lane.ts";
import type { UsageRecord } from "../types.ts";

// Pure session logic for the Postgres writer: which session a record belongs to, and how the records of one
// session in a batch collapse into the session row. Persisting and merging with stored rows is writer.ts.

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * The source-local session id of a record, or null (a record without one gets no session; none is invented).
 *
 *   raw.sessionId          claude-code, codex, opencode (message grain), anything that stamps it
 *   raw.agentId            a claude-code subagent: `<parent sessionId>:<agentId>`, its own session (raw.sessionId stays
 *                          the parent's for the session_env lookups); the parent link is raw.parentSessionId
 *   agent-workflows        raw.runId (the workflow run is the session), else raw.sessionId
 *   hermes, feuer          the session id inside the composite source id `<session>:<task>:<model>`
 *   any session-grain row  its own source id (opencode sessions, modelpick runs)
 *
 * litellm, astra and athena-teamchat rows carry no session id and stay NULL.
 */
export function sessionKey(source: string, r: Pick<UsageRecord, "sourceId" | "grain" | "raw">): string | null {
  if (source === "agent-workflows") return str(r.raw?.runId) ?? str(r.raw?.sessionId);
  const fromRaw = str(r.raw?.sessionId);
  if (fromRaw) return eventSessionKey({ sessionId: fromRaw, agentId: str(r.raw?.agentId) ?? undefined });
  if (source === "hermes" || source === "feuer") return str(r.sourceId.split(":")[0]);
  return r.grain === "session" ? str(r.sourceId) : null;
}

/** The session key of a transcript session event: `<sessionId>:<agentId>` for a subagent, else the session id (as `sessionKey`). */
export function eventSessionKey(e: { sessionId: string; agentId?: string }): string {
  return e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
}

/** The session that spawned this one, when the source says so (`raw.parentSessionId`): a claude-code subagent's parent. */
export function parentSessionKey(r: Pick<UsageRecord, "raw">): string | null {
  return str(r.raw?.parentSessionId);
}

/** A record reduced to what a session row needs. `ts` is epoch ms. */
export interface SessionInput {
  key: string;
  parentKey: string | null;
  ts: number;
  lane: Lane;
  laneDetail: LaneDetail | null;
  billing: "max" | "api_key" | "unknown";
  account: string | null;
  apiKey: string | null;
  machine: string | null;
  model: string | null;
  effort: string | null;
  repo: string | null;
  issueId: string | null;
  runId: string | null;
}

export interface SessionRow {
  source_session_id: string;
  parent_key: string | null;
  lane: Lane;
  lane_detail: LaneDetail | null;
  account: string | null;
  billing: "max" | "api_key" | "unknown";
  api_key: string | null;
  machine: string | null;
  model: string | null;
  effort: string | null;
  repo: string | null;
  issue_id: string | null;
  run_id: string | null;
  first_ts: string;
  last_ts: string;
}

/**
 * Collapse the records of each session in a batch into one row. Records are ordered non-subagent first, then by
 * time, and every attribute takes the first non-null value in that order: the session's lane is the earliest
 * non-subagent record's lane (a subagent request inside an interactive session stays `interactive`; only a
 * session seen through subagent records alone is `subagent`), and no attribute is ever erased by a NULL. `billing`
 * skips 'unknown' the same way. first_ts/last_ts span all records.
 */
export function aggregateSessions(inputs: SessionInput[]): SessionRow[] {
  const groups = new Map<string, SessionInput[]>();
  for (const i of inputs) {
    const g = groups.get(i.key);
    if (g) g.push(i);
    else groups.set(i.key, [i]);
  }
  const rows: SessionRow[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort((a, b) => Number(a.lane === "subagent") - Number(b.lane === "subagent") || a.ts - b.ts);
    const first = ordered[0] as SessionInput;
    const pick = <T>(f: (i: SessionInput) => T | null): T | null => {
      for (const i of ordered) {
        const v = f(i);
        if (v !== null) return v;
      }
      return null;
    };
    const times = group.map((i) => i.ts);
    rows.push({
      source_session_id: key,
      parent_key: pick((i) => (i.parentKey && i.parentKey !== key ? i.parentKey : null)),
      lane: first.lane,
      // a subagent whose first request carried no type (`unknown`) takes the first known one of the batch
      lane_detail: first.lane === "subagent" ? (ordered.find((i) => i.laneDetail?.subagent_type !== "unknown")?.laneDetail ?? first.laneDetail) : first.laneDetail,
      account: pick((i) => i.account),
      billing: pick((i) => (i.billing === "unknown" ? null : i.billing)) ?? "unknown",
      api_key: pick((i) => i.apiKey),
      machine: pick((i) => i.machine),
      model: pick((i) => i.model),
      effort: pick((i) => i.effort),
      repo: pick((i) => i.repo),
      issue_id: pick((i) => i.issueId),
      run_id: pick((i) => i.runId),
      first_ts: new Date(Math.min(...times)).toISOString(),
      last_ts: new Date(Math.max(...times)).toISOString(),
    });
  }
  return rows.sort((a, b) => (a.source_session_id < b.source_session_id ? -1 : 1));
}
