import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";
import type { ChangeExposure, ChangeNote, ChangeRecord } from "./changes.ts";

// `report weekly`: where the Max windows went in one ISO week, verdict first, findings with stable ids that are
// recomputed for the previous week so every finding carries its effect. Rules and ranges: docs/usage-schema.md §Weekly report.
// Everything is a function of (sql, [from, to)); nothing is stored.

// ---------- weeks ----------

const DAY_MS = 86_400_000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

export interface IsoWeek {
  label: string;
  from: Date;
  to: Date;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
/** Monday of ISO week 1 of `year` (the week holding January 4th). */
const week1Monday = (year: number) => {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
};

/** The ISO week (Monday 00:00 UTC to the next Monday) that holds `at`. */
export function isoWeekOf(at: Date): IsoWeek {
  const dow = (at.getUTCDay() + 6) % 7;
  const monday = dayStart(at) - dow * DAY_MS;
  const year = new Date(monday + 3 * DAY_MS).getUTCFullYear(); // the Thursday decides the ISO year
  const week = Math.round((monday - week1Monday(year)) / (7 * DAY_MS)) + 1;
  return { label: `${year}-W${pad2(week)}`, from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
}

/** `YYYY-Www` to its boundaries; throws on a bad format or a week the year does not have (W53 of a 52-week year). */
export function parseIsoWeek(label: string): IsoWeek {
  const m = WEEK_RE.exec(label);
  if (!m) throw new Error(`--week must look like 2026-W43, got "${label}"`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error(`--week ${label}: the week must be 01-53`);
  const from = new Date(week1Monday(year) + (week - 1) * 7 * DAY_MS);
  if (isoWeekOf(from).label !== label) throw new Error(`--week ${label}: ISO year ${year} has no week ${pad2(week)}`);
  return { label, from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** The last ISO week that has completely passed at `now`. */
export function lastFullIsoWeek(now: Date): IsoWeek {
  return isoWeekOf(new Date(isoWeekOf(now).from.getTime() - DAY_MS));
}

// ---------- thresholds ----------

export interface FindingThresholds {
  /** skill-size: loaded at least `minLoads` times in the week with an average size of at least `minAvgChars`. */
  skillSize: { minLoads: number; minAvgChars: number };
  /** subagent-effort: at least `minSessions` sessions and among the `topRank` subagent types by 7d points. */
  subagentEffort: { minSessions: number; topRank: number };
  /** role-tier: the role/lane holds at least `minShare` of the attributed 7d points, has `minSpawnsPerModel` Opus and Sonnet sessions, and Opus averages `minRatio` x Sonnet. */
  roleTier: { minShare: number; minSpawnsPerModel: number; minRatio: number };
  /** compaction-rate: a main lane with at least `minSessions` sessions and `minPerSession` compactions per session. */
  compactionRate: { minSessions: number; minPerSession: number };
  /** cache-ratio: a main lane with at least `minRequests` requests and a cache hit ratio below `maxRatio`. */
  cacheRatio: { maxRatio: number; minRequests: number };
}

export const FINDING_THRESHOLDS: FindingThresholds = {
  skillSize: { minLoads: 20, minAvgChars: 8000 },
  subagentEffort: { minSessions: 10, topRank: 3 },
  roleTier: { minShare: 0.2, minSpawnsPerModel: 5, minRatio: 2 },
  compactionRate: { minSessions: 5, minPerSession: 0.5 },
  cacheRatio: { maxRatio: 0.9, minRequests: 200 },
};

/** Lanes whose cache ratio and compaction rate say something about a prompt we own (a subagent's prefix is the parent's). */
export const MAIN_LANES: readonly string[] = ["interactive", "wave_mother", "lead", "worker", "fan_worker"];
const FACTORY_LANES = new Set(["wave_mother", "lead", "worker", "fan_worker"]);
const OWNER_FACTORY = "software-factory config/roles.json";

// ---------- shapes ----------

export interface NDelta {
  now: number | null;
  prev: number | null;
  delta: number | null;
}

export interface ShareRow {
  key: string;
  fiveHour: NDelta;
  sevenDay: NDelta;
  sessions: number;
}

export interface SkillRow {
  name: string;
  loads: NDelta;
  totalChars: NDelta;
  avgChars: NDelta;
}

export interface CacheRow {
  lane: string;
  requests: number;
  cacheHitRatio: NDelta;
  compactions: NDelta;
  sessions: number;
  compactionsPerSession: number | null;
}

export interface TopSession {
  session: string;
  lane: string;
  role: string;
  repo: string;
  issue: string;
  model: string;
  effort: string;
  account: string;
  fiveHourPts: number;
  sevenDayPts: number;
}

export interface Finding {
  id: string;
  rule: string;
  subject: string;
  claim: string;
  proposal: string;
  metric: { name: string; value: number; unit: string };
  /** `new`: absent last week. `recurring`: present both weeks, `prev` is last week's metric value. `unmeasured`: last week was not measured for this rule (no Claude Code records, or for a window rule no 7d readings), so "new" cannot be told. */
  trend: { status: "new" } | { status: "recurring"; prev: number; delta: number } | { status: "unmeasured" };
}

export interface ResolvedFinding {
  id: string;
  rule: string;
  subject: string;
  claim: string;
  metric: { name: string; value: number; unit: string };
}

/** A finding with the recorded changes that answer it (docs/usage-schema.md §Finding changes). */
export type Answered<T> = T & { changes: ChangeNote[] };

/** The point fields are null when the week has no readings of THIS window (unknown, not zero movement). */
/** A reading of a window is a `quota_samples` row with that window's pct AND resets_at (the `window_intervals` predicate). */
export interface WindowReadings {
  fiveHour: boolean;
  sevenDay: boolean;
}

export interface CoverageRow {
  win: "five_hour" | "seven_day";
  movedPts: number | null;
  attributedPts: number | null;
  residualPts: number | null;
  residualPct: number | null;
  prevMovedPts: number | null;
}

export interface WeeklyReport {
  week: string;
  from: string;
  to: string;
  previous: { week: string; from: string; to: string; hasWindowData: boolean; windowReadings: WindowReadings; hasClaudeData: boolean };
  empty: boolean;
  /** Quota readings of either window exist in this week; per window in `windowReadings`. False means every window figure is unknown. */
  hasWindowData: boolean;
  windowReadings: WindowReadings;
  /** Any Claude Code record (`records_unique`) in the week. */
  hasClaudeData: boolean;
  verdict: {
    lines: string[];
    topLane: { lane: string; sevenDayShare: number | null; fiveHourShare: number | null } | null;
    weekOverWeek: { fiveHourPct: number | null; sevenDayPct: number | null } | null;
  };
  tables: {
    lane: ShareRow[];
    role: ShareRow[];
    subagentType: ShareRow[];
    skills: SkillRow[];
    cache: CacheRow[];
    topSessions: TopSession[];
  };
  findings: Answered<Finding>[];
  resolved: Answered<ResolvedFinding>[];
  /** Findings of the previous week that cannot be judged because this week was not measured for their rule (no Claude Code records, or no 7d readings for a window rule). */
  unknown: Answered<ResolvedFinding>[];
  /** Recorded changes whose finding is not listed above (declined, handed off, or a finding gone for longer than a week). */
  otherChanges: ChangeNote[];
  coverage: CoverageRow[];
}

// ---------- loading one week ----------

interface SessionShare {
  /** Attribution rows without a session (NULL id or no `sessions` row): their points count in the totals, they are no session. */
  synthetic: boolean;
  sessionId: number | null;
  sid: string;
  lane: string;
  role: string;
  subagentType: string;
  repo: string;
  issue: string;
  model: string;
  effort: string;
  account: string;
  five: number;
  seven: number;
}

interface LaneData {
  requests: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number };
  compactions: number;
  sessions: number;
}

interface SkillAgg {
  loads: number;
  sized: number;
  chars: number;
}

interface WeekData {
  /** Quota readings per window in the week: decides "no window data". Zero movement with readings is a measured 0. */
  readings: { five: number; seven: number };
  /** Claude Code sessions active in the week plus any session with an attributed share (share 0 when none). */
  sessions: SessionShare[];
  moved: { five: number; seven: number };
  attributed: { five: number; seven: number };
  lanes: Map<string, LaneData>;
  /** Keyed by the ORIGINAL skill name (untrusted text); only `skillLabels` makes it showable. */
  skills: Map<string, SkillAgg>;
}

/** A skill name is shown only if it looks like a skill name (no dots: no hostnames or addresses); the rest is `(other)`. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,60}$/;
const SKILL_OTHER = "(other)";

/** Showable label per skill; unsafe names merge into `(other)` here, after aggregation. */
function skillLabels(skills: Map<string, SkillAgg>): Map<string, SkillAgg> {
  const out = new Map<string, SkillAgg>();
  for (const [name, s] of skills) {
    const label = SKILL_NAME_RE.test(name) ? name : SKILL_OTHER;
    const a = out.get(label) ?? { loads: 0, sized: 0, chars: 0 };
    out.set(label, { loads: a.loads + s.loads, sized: a.sized + s.sized, chars: a.chars + s.chars });
  }
  return out;
}

/** Report strings come from the database; nothing that looks like a URL, a secret reference or an address leaves it. */
export function clean(value: unknown, fallback = "(none)"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "(ref)")
    .replace(/\S+@\S+/g, "(address)")
    .replace(/@/g, "");
}

const num = (v: unknown) => Number(v ?? 0);

async function loadWeek(tx: SQL, from: Date, to: Date): Promise<WeekData> {
  const f = from.toISOString();
  const t = to.toISOString();
  // lane_signals is day-grained; weeks start at UTC midnight so [from, to) is whole days.
  const fromDay = f.slice(0, 10);
  const toDay = t.slice(0, 10);

  const readings = await tx`
    SELECT count(*) FILTER (WHERE five_hour_pct IS NOT NULL AND five_hour_resets_at IS NOT NULL)::int AS five,
           count(*) FILTER (WHERE seven_day_pct IS NOT NULL AND seven_day_resets_at IS NOT NULL)::int AS seven
    FROM usage.quota_samples WHERE sampled_at >= ${f}::timestamptz AND sampled_at < ${t}::timestamptz`;
  const shares = await tx`
    WITH sh AS (
      SELECT a.session_id,
             coalesce(sum(a.share_pct) FILTER (WHERE a.win = 'five_hour'), 0)::float8 AS five,
             coalesce(sum(a.share_pct) FILTER (WHERE a.win = 'seven_day'), 0)::float8 AS seven
      FROM usage.window_attribution a
      WHERE a.to_at >= ${f}::timestamptz AND a.to_at < ${t}::timestamptz
      GROUP BY a.session_id),
    ids AS (
      SELECT id AS session_id FROM usage.sessions WHERE source = 'claude-code' AND last_ts >= ${f}::timestamptz AND first_ts < ${t}::timestamptz
      UNION
      SELECT session_id FROM sh)
    SELECT ids.session_id, coalesce(sh.five, 0)::float8 AS five, coalesce(sh.seven, 0)::float8 AS seven, s.source_session_id, s.lane, s.lane_detail->>'role' AS role,
           s.lane_detail->>'subagent_type' AS subagent_type, s.repo, s.issue_id, s.model, s.effort, s.account
    FROM ids LEFT JOIN sh ON sh.session_id IS NOT DISTINCT FROM ids.session_id
    LEFT JOIN usage.sessions s ON s.id = ids.session_id`;
  const coverage = await tx`
    SELECT i.win, coalesce(sum(i.delta_pct), 0)::float8 AS moved,
           coalesce(sum(i.delta_pct) FILTER (WHERE i.records_cost > 0), 0)::float8 AS attributed
    FROM usage.window_intervals i
    WHERE i.to_at >= ${f}::timestamptz AND i.to_at < ${t}::timestamptz
    GROUP BY i.win`;
  const signals = await tx`
    SELECT lane, coalesce(sum(input_tokens), 0)::float8 AS input, coalesce(sum(cache_read_tokens), 0)::float8 AS cache_read,
           coalesce(sum(cache_write_5m_tokens + cache_write_1h_tokens), 0)::float8 AS cache_write,
           coalesce(sum(compactions), 0)::int AS compactions
    FROM usage.lane_signals
    WHERE source = 'claude-code' AND day >= ${fromDay}::date AND day < ${toDay}::date
    GROUP BY lane`;
  const requests = await tx`
    SELECT lane, count(*)::int AS n FROM usage.records_unique
    WHERE source = 'claude-code' AND ts >= ${f}::timestamptz AND ts < ${t}::timestamptz GROUP BY lane`;
  const sessions = await tx`
    SELECT lane, count(*)::int AS n FROM usage.sessions
    WHERE source = 'claude-code' AND last_ts >= ${f}::timestamptz AND first_ts < ${t}::timestamptz GROUP BY lane`;
  const skills = await tx`
    SELECT name, count(*)::int AS loads, count(size_chars)::int AS sized, coalesce(sum(size_chars), 0)::float8 AS chars
    FROM usage.session_events
    WHERE kind = 'skill' AND name IS NOT NULL AND ts >= ${f}::timestamptz AND ts < ${t}::timestamptz GROUP BY name`;

  const moved = { five: 0, seven: 0 };
  const attributed = { five: 0, seven: 0 };
  for (const c of coverage as Record<string, unknown>[]) {
    const k = c.win === "five_hour" ? "five" : "seven";
    moved[k] = num(c.moved);
    attributed[k] = num(c.attributed);
  }

  const lanes = new Map<string, LaneData>();
  const lane = (name: unknown): LaneData => {
    const key = clean(name, "(none)");
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { requests: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0 }, compactions: 0, sessions: 0 }));
    return l;
  };
  for (const r of signals as Record<string, unknown>[]) {
    const l = lane(r.lane);
    l.tokens = { input: num(r.input), cacheRead: num(r.cache_read), cacheWrite: num(r.cache_write) };
    l.compactions = num(r.compactions);
  }
  for (const r of requests as Record<string, unknown>[]) lane(r.lane).requests = num(r.n);
  for (const r of sessions as Record<string, unknown>[]) lane(r.lane).sessions = num(r.n);

  return {
    readings: { five: num((readings[0] as Record<string, unknown> | undefined)?.five), seven: num((readings[0] as Record<string, unknown> | undefined)?.seven) },
    moved,
    attributed,
    lanes,
    sessions: (shares as Record<string, unknown>[]).map((r) => ({
      synthetic: r.session_id === null || r.source_session_id === null,
      sessionId: r.session_id === null ? null : num(r.session_id),
      sid: clean(r.source_session_id, "(no session)"),
      lane: clean(r.lane, "(no session)"),
      role: clean(r.role),
      subagentType: clean(r.subagent_type),
      repo: clean(r.repo),
      issue: clean(r.issue_id),
      model: clean(r.model),
      effort: clean(r.effort),
      account: clean(r.account),
      five: num(r.five),
      seven: num(r.seven),
    })),
    skills: new Map(
      (skills as Record<string, unknown>[]).map((r) => [String(r.name), { loads: num(r.loads), sized: num(r.sized), chars: num(r.chars) }]),
    ),
  };
}

const windowReadings = (d: WeekData): WindowReadings => ({ fiveHour: d.readings.five > 0, sevenDay: d.readings.seven > 0 });
const hasWindowData = (d: WeekData) => d.readings.five > 0 || d.readings.seven > 0;
/** Any Claude Code record in the week: without it the records-derived rules cannot say anything about the week. */
const hasClaudeData = (d: WeekData) => [...d.lanes.values()].some((l) => l.requests > 0);
const isEmpty = (d: WeekData) => !hasWindowData(d) && d.sessions.length === 0 && d.skills.size === 0 && [...d.lanes.values()].every((l) => l.requests === 0 && l.compactions === 0 && l.sessions === 0);

// ---------- aggregation ----------

interface Group {
  five: number;
  seven: number;
  sessions: number;
}

function groupBy(rows: SessionShare[], key: (s: SessionShare) => string): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const s of rows) {
    const k = key(s);
    const g = out.get(k) ?? { five: 0, seven: 0, sessions: 0 };
    g.five += s.five;
    g.seven += s.seven;
    if (!s.synthetic) g.sessions += 1;
    out.set(k, g);
  }
  return out;
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const nDelta = (now: number | null, prev: number | null): NDelta => ({
  now: now === null ? null : round(now),
  prev: prev === null ? null : round(prev),
  delta: now !== null && prev !== null ? round(now - prev) : null,
});

/** `cur` / `before`: which windows have readings this week / last week. A point figure exists only for a measured window, a delta for a window measured in both. */
function shareTable(now: Map<string, Group>, prev: Map<string, Group>, top: number, cur: WindowReadings, before: WindowReadings): ShareRow[] {
  return [...now.entries()]
    .sort(([ak, a], [bk, b]) => b.seven - a.seven || b.five - a.five || ak.localeCompare(bk))
    .slice(0, top)
    .map(([key, g]) => ({
      key,
      fiveHour: cur.fiveHour ? nDelta(g.five, before.fiveHour ? (prev.get(key)?.five ?? 0) : null) : nDelta(null, null),
      sevenDay: cur.sevenDay ? nDelta(g.seven, before.sevenDay ? (prev.get(key)?.seven ?? 0) : null) : nDelta(null, null),
      sessions: g.sessions,
    }));
}

const cacheRatio = (l: LaneData | undefined): number | null => {
  if (!l) return null;
  const total = l.tokens.input + l.tokens.cacheRead + l.tokens.cacheWrite;
  return total > 0 ? l.tokens.cacheRead / total : null;
};
const avgChars = (s: SkillAgg | undefined) => (s && s.sized > 0 ? s.chars / s.sized : null);

// ---------- findings ----------

export type RawFinding = Omit<Finding, "trend">;

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const modelClass = (model: string) => (/opus/i.test(model) ? "opus" : /sonnet/i.test(model) ? "sonnet" : null);
const ownerOf = (lane: string) => (FACTORY_LANES.has(lane) ? OWNER_FACTORY : "dotfiles");

/** Pure: the same data and thresholds always give the same findings, ordered by rule then id. */
export function findingsFor(d: WeekData, th: FindingThresholds = FINDING_THRESHOLDS): RawFinding[] {
  const out: RawFinding[] = [];

  for (const [name, s] of d.skills) {
    if (!SKILL_NAME_RE.test(name)) continue; // an unsafe name cannot be a finding subject
    const avg = avgChars(s);
    if (s.loads < th.skillSize.minLoads || avg === null || avg < th.skillSize.minAvgChars) continue;
    out.push({
      id: `skill-size:${name}`,
      rule: "skill-size",
      subject: name,
      claim: `Skill "${name}" was loaded ${s.loads} times at ${int(avg)} characters on average (${int(s.chars)} characters, about ${int(s.chars / 4)} tokens, in the week).`,
      proposal: `Trim the "${name}" skill in dotfiles below ${int(th.skillSize.minAvgChars)} characters by moving reference material into files it loads on demand.`,
      metric: { name: "avg_size_chars", value: round(avg, 0), unit: "chars" },
    });
  }

  const typed = groupBy(d.sessions, (s) => s.subagentType);
  const ranked = [...typed.entries()]
    .filter(([k, g]) => k !== "(none)" && g.seven > 0)
    .sort(([ak, a], [bk, b]) => b.seven - a.seven || ak.localeCompare(bk));
  ranked.forEach(([type, g], i) => {
    if (i >= th.subagentEffort.topRank || g.sessions < th.subagentEffort.minSessions) return;
    out.push({
      id: `subagent-effort:${type}`,
      rule: "subagent-effort",
      subject: type,
      claim: `Subagent type "${type}" ran ${g.sessions} sessions and took ${f1(g.seven)} points of the 7d window (rank ${i + 1} of ${ranked.length} subagent types), ${f2(g.seven / g.sessions)} points per session.`,
      proposal: `Lower the default effort of the "${type}" subagent definition in dotfiles by one level.`,
      metric: { name: "window_7d_pts_per_session", value: round(g.seven / g.sessions), unit: "pts" },
    });
  });

  const attributed7 = d.attributed.seven;
  const tierGroups: { kind: "Role" | "Lane"; subject: string; rows: SessionShare[] }[] = [];
  const bySubject = (kind: "Role" | "Lane", key: (s: SessionShare) => string, skip: (k: string) => boolean) => {
    const m = new Map<string, SessionShare[]>();
    for (const s of d.sessions) {
      const k = key(s);
      if (skip(k)) continue;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    for (const [subject, rows] of [...m.entries()].sort(([a], [b]) => a.localeCompare(b))) tierGroups.push({ kind, subject, rows });
  };
  bySubject("Role", (s) => s.role, (k) => k === "(none)");
  bySubject("Lane", (s) => s.lane, (k) => k === "subagent" || k === "(no session)");
  const seen = new Set<string>();
  for (const { kind, subject, rows } of tierGroups) {
    const id = `role-tier:${subject}`;
    if (attributed7 <= 0 || seen.has(id)) continue; // a role and a lane of one name are the same finding: the role wins
    const share = rows.reduce((sum, r) => sum + r.seven, 0) / attributed7;
    if (share < th.roleTier.minShare) continue;
    const opus = rows.filter((r) => modelClass(r.model) === "opus");
    const sonnet = rows.filter((r) => modelClass(r.model) === "sonnet");
    if (opus.length < th.roleTier.minSpawnsPerModel || sonnet.length < th.roleTier.minSpawnsPerModel) continue;
    const opusMean = opus.reduce((sum, r) => sum + r.seven, 0) / opus.length;
    const sonnetMean = sonnet.reduce((sum, r) => sum + r.seven, 0) / sonnet.length;
    if (sonnetMean <= 0 || opusMean / sonnetMean < th.roleTier.minRatio) continue;
    seen.add(id);
    const ratio = opusMean / sonnetMean;
    out.push({
      id,
      rule: "role-tier",
      subject,
      claim: `${kind} "${subject}" holds ${f1(share * 100)}% of the attributed 7d points; its ${opus.length} Opus sessions averaged ${f2(opusMean)} points of the 7d window against ${f2(sonnetMean)} for ${sonnet.length} Sonnet sessions (${f1(ratio)}x).`,
      proposal:
        kind === "Role"
          ? `Default the "${subject}" role to a Sonnet-class model in ${OWNER_FACTORY}.`
          : `Default the "${subject}" lane to a Sonnet-class model in dotfiles config/claude-effort.json.`,
      metric: { name: "opus_vs_sonnet_mean_7d_ratio", value: round(ratio, 2), unit: "x" },
    });
  }

  for (const lane of MAIN_LANES) {
    const l = d.lanes.get(lane);
    if (!l || l.sessions < th.compactionRate.minSessions) continue;
    const rate = l.compactions / l.sessions;
    if (rate < th.compactionRate.minPerSession) continue;
    out.push({
      id: `compaction-rate:${lane}`,
      rule: "compaction-rate",
      subject: lane,
      claim: `Lane "${lane}" compacted ${l.compactions} times across ${l.sessions} sessions (${f2(rate)} per session).`,
      proposal: FACTORY_LANES.has(lane)
        ? `Shorten the unit of work a "${lane}" session takes on in ${OWNER_FACTORY} so it ends before its context compacts.`
        : `Add a checkpoint-and-restart step to the "${lane}" session guidance in dotfiles so long sessions are split before they compact.`,
      metric: { name: "compactions_per_session", value: round(rate, 2), unit: "per session" },
    });
  }

  for (const lane of MAIN_LANES) {
    const l = d.lanes.get(lane);
    const ratio = cacheRatio(l);
    if (!l || ratio === null || l.requests < th.cacheRatio.minRequests || ratio >= th.cacheRatio.maxRatio) continue;
    out.push({
      id: `cache-ratio:${lane}`,
      rule: "cache-ratio",
      subject: lane,
      claim: `Lane "${lane}" served ${f1(ratio * 100)}% of its input tokens from cache over ${int(l.requests)} requests (below ${f1(th.cacheRatio.maxRatio * 100)}%).`,
      proposal: `Keep the "${lane}" lane's prompt prefix stable in ${ownerOf(lane)}: move timestamps and per-run ids behind the cached prefix.`,
      metric: { name: "cache_hit_ratio", value: round(ratio), unit: "ratio" },
    });
  }
  return out;
}

const RULE_ORDER = ["skill-size", "subagent-effort", "role-tier", "compaction-rate", "cache-ratio"];

/** Rules that read the 7d window (their metric is 7d points); every rule reads Claude Code records or events. */
const WINDOW_RULES = new Set(["subagent-effort", "role-tier"]);

/** What a week can say: `claude` = Claude Code records exist, `sevenDay` = the 7d window has readings. */
export interface Measured {
  claude: boolean;
  sevenDay: boolean;
}

const measuredFor = (rule: string, m: Measured) => m.claude && (!WINDOW_RULES.has(rule) || m.sevenDay);

/** A rule not measured this week leaves last week's findings `unknown` (never resolved); not measured last week, a present one is `unmeasured` (never new). */
export function trackFindings(
  now: RawFinding[],
  prev: RawFinding[],
  weeks: { cur: Measured; prev: Measured },
): { findings: Finding[]; resolved: ResolvedFinding[]; unknown: ResolvedFinding[] } {
  const prevById = new Map(prev.map((f) => [f.id, f]));
  const nowIds = new Set(now.map((f) => f.id));
  const order = (a: RawFinding, b: RawFinding) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) || a.id.localeCompare(b.id);
  const gone = prev
    .filter((f) => !nowIds.has(f.id))
    .sort(order)
    .map(({ id, rule, subject, claim, metric }) => ({ id, rule, subject, claim, metric }));
  const unmeasurable = (f: { rule: string }) => !measuredFor(f.rule, weeks.cur);
  return {
    findings: [...now].sort(order).map((f) => {
      const p = prevById.get(f.id);
      if (p) return { ...f, trend: { status: "recurring", prev: p.metric.value, delta: round(f.metric.value - p.metric.value) } };
      return { ...f, trend: !measuredFor(f.rule, weeks.prev) ? { status: "unmeasured" } : { status: "new" } };
    }),
    resolved: gone.filter((f) => !unmeasurable(f)),
    unknown: gone.filter(unmeasurable),
  };
}

// ---------- the report ----------

export interface WeeklyOptions {
  /** `YYYY-Www`; default the last full ISO week before `now`. */
  week?: string;
  now?: Date;
  /** Rows per table, the top-sessions table included (default 10). */
  top?: number;
  thresholds?: FindingThresholds;
  /** Recorded changes per finding id (`loadChanges()` in the CLI); default none, so the report is a function of the database alone. */
  changes?: ChangeRecord[];
}

const topSessionRow = (s: SessionShare): TopSession => {
  const [head, agent] = s.sid.split(":");
  return {
    session: agent === undefined ? s.sid.slice(0, 8) : `${(head ?? "").slice(0, 8)}:${agent.slice(0, 6)}`,
    lane: s.lane,
    role: s.role,
    repo: s.repo,
    issue: s.issue,
    model: s.model,
    effort: s.effort,
    account: s.account,
    fiveHourPts: round(s.five),
    sevenDayPts: round(s.seven),
  };
};

/** A record placed against the covered week (`weekFrom` = its Monday): `full` = both compared weeks ran wholly under the change, `partial` = it landed in one of them. A later replacement is not modelled: whether an older change still stands is the reader's call. */
export function noteOf(c: ChangeRecord, weekFrom: Date): ChangeNote {
  const at = new Date(`${c.date}T00:00:00Z`);
  const prevFrom = new Date(weekFrom.getTime() - 7 * DAY_MS);
  const nextFrom = new Date(weekFrom.getTime() + 7 * DAY_MS);
  const exposure: ChangeExposure | null = c.status !== "landed" ? null : at >= nextFrom ? "not-yet" : isoWeekOf(at).from < prevFrom ? "full" : "partial";
  return {
    ...c,
    summary: clean(c.summary), // the file is authored, but the report promises no host, address or secret reference in either output
    week: isoWeekOf(at).label,
    cleanFrom: c.status === "landed" ? isoWeekOf(new Date(at.getTime() + 14 * DAY_MS)).label : null,
    exposure,
  };
}

const pctChange = (now: number, prev: number) => (prev > 0 ? round(((now - prev) / prev) * 100, 1) : null);
const signed = (n: number, digits = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

export async function weeklyReport(sql: SQL, opts: WeeklyOptions = {}): Promise<WeeklyReport> {
  const week = opts.week ? parseIsoWeek(opts.week) : lastFullIsoWeek(opts.now ?? new Date());
  const prevWeek = isoWeekOf(new Date(week.from.getTime() - DAY_MS));
  const top = opts.top ?? 10;
  const th = opts.thresholds ?? FINDING_THRESHOLDS;

  // One snapshot for both weeks: an ingest committing in between would make the deltas disagree with the rows.
  const [cur, prev] = await sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    const cur = await loadWeek(tx, week.from, week.to);
    return [cur, await loadWeek(tx, prevWeek.from, prevWeek.to)] as const;
  });

  const cw = windowReadings(cur);
  const pw = windowReadings(prev);
  const curWindow = hasWindowData(cur);
  const prevWindow = hasWindowData(prev);
  const curClaude = hasClaudeData(cur);
  const prevClaude = hasClaudeData(prev);
  const prevHasSkills = prev.skills.size > 0;
  const prevHasLanes = [...prev.lanes.values()].some((l) => l.requests > 0 || l.sessions > 0);
  // Per window: without this week's readings even `now` is unknown, not 0; a delta needs readings in both weeks.
  const share = (key: (s: SessionShare) => string) => shareTable(groupBy(cur.sessions, key), groupBy(prev.sessions, key), top, cw, pw);
  const lane = share((s) => s.lane);
  const role = share((s) => s.role);
  const subagentType = share((s) => s.subagentType);

  const curSkills = skillLabels(cur.skills);
  const prevSkills = skillLabels(prev.skills);
  const skills: SkillRow[] = [...curSkills.entries()]
    .sort(([ak, a], [bk, b]) => b.chars - a.chars || b.loads - a.loads || ak.localeCompare(bk))
    .slice(0, top)
    .map(([name, s]) => {
      const p = prevSkills.get(name);
      return {
        name,
        loads: nDelta(s.loads, prevHasSkills ? (p?.loads ?? 0) : null),
        totalChars: nDelta(s.chars, prevHasSkills ? (p?.chars ?? 0) : null),
        avgChars: nDelta(avgChars(s), prevHasSkills ? avgChars(p) : null),
      };
    });

  const cache: CacheRow[] = [...cur.lanes.entries()]
    .filter(([, l]) => l.requests > 0 || l.compactions > 0 || l.sessions > 0)
    .sort(([ak, a], [bk, b]) => b.requests - a.requests || ak.localeCompare(bk))
    .slice(0, top)
    .map(([name, l]) => {
      const p = prev.lanes.get(name);
      return {
        lane: name,
        requests: l.requests,
        cacheHitRatio: nDelta(cacheRatio(l), prevHasLanes ? cacheRatio(p) : null),
        compactions: nDelta(l.compactions, prevHasLanes ? (p?.compactions ?? 0) : null),
        sessions: l.sessions,
        compactionsPerSession: l.sessions > 0 ? round(l.compactions / l.sessions, 2) : null,
      };
    });

  const topSessions = cur.sessions
    .filter((s) => !s.synthetic && (s.seven > 0 || s.five > 0))
    .sort((a, b) => b.seven - a.seven || b.five - a.five || a.sid.localeCompare(b.sid))
    .slice(0, top)
    .map(topSessionRow);

  const { findings, resolved, unknown } = trackFindings(findingsFor(cur, th), findingsFor(prev, th), {
    cur: { claude: curClaude, sevenDay: cw.sevenDay },
    prev: { claude: prevClaude, sevenDay: pw.sevenDay },
  });

  const records = opts.changes ?? [];
  const byDate = (a: ChangeRecord, b: ChangeRecord) => a.date.localeCompare(b.date) || a.finding.localeCompare(b.finding);
  const answered = <T extends { id: string }>(items: T[]): Answered<T>[] =>
    items.map((f) => ({ ...f, changes: records.filter((c) => c.finding === f.id).sort(byDate).map((c) => noteOf(c, week.from)) }));
  const listed = new Set([...findings, ...resolved, ...unknown].map((f) => f.id));
  const otherChanges = records
    .filter((c) => !listed.has(c.finding))
    .sort(byDate)
    .map((c) => noteOf(c, week.from));

  const coverage: CoverageRow[] = (["five_hour", "seven_day"] as const).map((win) => {
    const k = win === "five_hour" ? "five" : "seven";
    const movedPts = cur.moved[k];
    const attributedPts = cur.attributed[k];
    const measured = k === "five" ? cw.fiveHour : cw.sevenDay;
    const prevMeasured = k === "five" ? pw.fiveHour : pw.sevenDay;
    return {
      win,
      movedPts: measured ? round(movedPts) : null,
      attributedPts: measured ? round(attributedPts) : null,
      residualPts: measured ? round(movedPts - attributedPts) : null,
      residualPct: measured && movedPts > 0 ? round(((movedPts - attributedPts) / movedPts) * 100, 1) : null,
      prevMovedPts: prevMeasured ? round(prev.moved[k]) : null,
    };
  });

  const empty = isEmpty(cur);
  const topEntry = [...groupBy(cur.sessions, (s) => s.lane).entries()]
    .filter(([k]) => k !== "(no session)")
    .sort(([ak, a], [bk, b]) => b.seven - a.seven || b.five - a.five || ak.localeCompare(bk))[0];
  const pctOf = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100, 1) : null);
  const topLane = curWindow && topEntry && (topEntry[1].seven > 0 || topEntry[1].five > 0)
    ? {
        lane: topEntry[0],
        sevenDayShare: cw.sevenDay ? pctOf(topEntry[1].seven, cur.attributed.seven) : null,
        fiveHourShare: cw.fiveHour ? pctOf(topEntry[1].five, cur.attributed.five) : null,
      }
    : null;
  const comparable = { five: cw.fiveHour && pw.fiveHour, seven: cw.sevenDay && pw.sevenDay };
  const weekOverWeek = comparable.five || comparable.seven
    ? {
        fiveHourPct: comparable.five ? pctChange(cur.moved.five, prev.moved.five) : null,
        sevenDayPct: comparable.seven ? pctChange(cur.moved.seven, prev.moved.seven) : null,
      }
    : null;

  const range = `${week.from.toISOString().slice(0, 10)} to ${week.to.toISOString().slice(0, 10)} UTC`;
  const lines: string[] = [];
  const plural = (n: number) => `finding${n === 1 ? "" : "s"}`;
  if (empty) {
    lines.push(`No window data and no signals in ${week.label} (${range}): nothing to report.`);
    if (resolved.length + unknown.length > 0) {
      lines.push(`Against ${prevWeek.label}: ${resolved.length} resolved, ${unknown.length} unknown (not measured this week); nothing was measured this week.`);
    }
  } else {
    const [five, seven] = coverage as [CoverageRow, CoverageRow];
    const resid = (c: CoverageRow) => (c.residualPct === null ? "-" : `${c.residualPct.toFixed(1)}%`);
    if (curWindow) {
      const part = (label: string, c: CoverageRow, verb: string) =>
        c.movedPts === null
          ? `the ${label} windows have no readings (unknown)`
          : `the ${label} windows ${verb}${f1(c.movedPts)} points (${f1(c.attributedPts ?? 0)} attributed, ${resid(c)} residual)`;
      lines.push(`${week.label} (${range}): ${part("5h", five, "moved ")}, ${part("7d", seven, five.movedPts === null ? "moved " : "")}.`);
      const topText = topLane
        ? cw.sevenDay
          ? `Top lane: ${topLane.lane} with ${topLane.sevenDayShare === null ? "-" : `${topLane.sevenDayShare.toFixed(1)}%`} of the attributed 7d points (${topLane.fiveHourShare === null ? "-" : `${topLane.fiveHourShare.toFixed(1)}%`} of 5h).`
          : `Top lane: ${topLane.lane} with ${topLane.fiveHourShare === null ? "-" : `${topLane.fiveHourShare.toFixed(1)}%`} of the attributed 5h points (7d unknown).`
        : "No lane has attributed window movement from a known session.";
      const wowPart = (label: string, now: number, before: number, change: number | null) =>
        `${label} ${change === null ? "n/a" : `${signed(change)}%`} (${f1(before)} -> ${f1(now)})`;
      const wowParts = [
        ...(comparable.five ? [wowPart("5h", cur.moved.five, prev.moved.five, weekOverWeek?.fiveHourPct ?? null)] : []),
        ...(comparable.seven ? [wowPart("7d", cur.moved.seven, prev.moved.seven, weekOverWeek?.sevenDayPct ?? null)] : []),
      ];
      const wowText = weekOverWeek
        ? `Week over week: ${wowParts.join(", ")}.`
        : prevWindow
          ? `No window has readings in both ${prevWeek.label} and ${week.label}, so no week-over-week change.`
          : `No window data in ${prevWeek.label}, so no week-over-week change.`;
      lines.push(`${topText} ${wowText}`);
    } else {
      lines.push(`${week.label} (${range}): no quota readings in the week, so the window figures are unknown (not zero); only the cache, compaction and skill figures below are measured.`);
    }
    if (!curClaude) lines.push(`No Claude Code records in ${week.label} (ingest down or a quiet week): findings from records and events cannot be judged.`);
    const fresh = findings.filter((f) => f.trend.status === "new").length;
    const unmeasured = findings.filter((f) => f.trend.status === "unmeasured").length;
    lines.push(
      `${findings.length} ${plural(findings.length)} (${fresh} new, ${findings.length - fresh - unmeasured} recurring${unmeasured > 0 ? `, ${unmeasured} unmeasured` : ""}), ${resolved.length} resolved${unknown.length > 0 ? `, ${unknown.length} unknown (not measured this week)` : ""} since ${prevWeek.label}.`,
    );
  }

  return {
    week: week.label,
    from: week.from.toISOString(),
    to: week.to.toISOString(),
    previous: { week: prevWeek.label, from: prevWeek.from.toISOString(), to: prevWeek.to.toISOString(), hasWindowData: prevWindow, windowReadings: pw, hasClaudeData: prevClaude },
    empty,
    hasWindowData: curWindow,
    windowReadings: cw,
    hasClaudeData: curClaude,
    verdict: { lines, topLane, weekOverWeek },
    tables: { lane, role, subagentType, skills, cache, topSessions },
    findings: answered(findings),
    resolved: answered(resolved),
    unknown: answered(unknown),
    otherChanges,
    coverage,
  };
}

// ---------- rendering ----------

const cell = (s: string) => s.replace(/\|/g, "/");
const fmt = (n: number | null, digits = 1) => (n === null ? "-" : n.toFixed(digits));
const fmtDelta = (n: number | null, digits = 1) => (n === null ? "-" : signed(n, digits));
const fmtInt = (n: number | null) => (n === null ? "-" : int(n));
const fmtIntDelta = (n: number | null) => (n === null ? "-" : `${n >= 0 ? "+" : "-"}${int(Math.abs(n))}`);

function table(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "-").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function shareMd(title: string, key: string, rows: ShareRow[]): string {
  if (rows.length === 0) return `### ${title}\n\n(no attributed window movement)`;
  return `### ${title}\n\n${table(
    [key, "5h now", "5h prev", "5h delta", "7d now", "7d prev", "7d delta", "sessions"],
    rows.map((r) => [r.key, fmt(r.fiveHour.now), fmt(r.fiveHour.prev), fmtDelta(r.fiveHour.delta), fmt(r.sevenDay.now), fmt(r.sevenDay.prev), fmtDelta(r.sevenDay.delta), String(r.sessions)]),
  )}`;
}

export function formatWeekly(report: WeeklyReport): string {
  const out: string[] = [`# Where the window went: ${report.week}`, "", "## Verdict", "", ...report.verdict.lines.map((l) => `- ${l}`)];
  const coverageMd = () => {
    const label = (c: CoverageRow) => (c.win === "five_hour" ? "5h" : "7d");
    const parts = report.coverage.map(
      (c) =>
        c.movedPts === null
          ? `${label(c)} has no readings (unknown, not zero)`
          : `${label(c)} moved ${fmt(c.movedPts)}, attributed ${fmt(c.attributedPts)}, residual ${fmt(c.residualPts)} (${c.residualPct === null ? "-" : `${c.residualPct.toFixed(1)}%`})`,
    );
    return [
      "## Coverage",
      "",
      report.hasWindowData ? `${parts.join("; ")}.` : "No quota readings in the week: the window movement is unknown, not zero.",
      `Residual is window movement in intervals with no priced Max record (a lagging mirror, a machine we do not collect, an unpriced model).`,
      "",
      "Points are points of one account's window; a row spanning accounts adds points of different windows. The 7-day meter moves in whole points, so a single session's 7d share is noisy; sums over lanes, roles and types are the reliable figures.",
    ];
  };
  const changeLine = (c: ChangeNote) => {
    const what = c.status === "landed" ? `landed ${c.date}${c.ref === null ? "" : ` (${c.ref})`}` : `${c.status} ${c.date}`;
    const when =
      c.exposure === "full"
        ? `both compared weeks ran under it`
        : c.exposure === "partial"
          ? `landed in ${c.week}, so ${c.week === report.week ? "this week ran" : `${report.previous.week} ran`} partly under it; the first clean comparison is the report for ${c.cleanFrom}`
          : c.exposure === "not-yet"
            ? `lands after ${report.week}, no effect yet`
            : null;
    return `  - Change: ${what}: ${clean(c.summary)}${when === null ? "" : ` (${when})`}`;
  };
  const findingsMd = (): string[] => {
    const lines = ["## Findings", ""];
    if (report.findings.length === 0) lines.push("(none)");
    for (const f of report.findings) {
      const t = f.trend;
      const effect =
        t.status === "new"
          ? `new (${f.metric.value} ${f.metric.unit})`
          : t.status === "unmeasured"
            ? `${report.previous.week} was not measured for this rule, effect unknown (${f.metric.value} ${f.metric.unit})`
            : `${t.prev} -> ${f.metric.value} ${f.metric.unit} (${t.delta >= 0 ? "+" : ""}${t.delta})`;
      lines.push(`- **${f.id}**: ${f.claim}`, `  - Proposal: ${f.proposal}`, `  - ${f.metric.name}: ${effect}`, ...f.changes.map(changeLine));
    }
    if (report.resolved.length > 0) {
      lines.push("", "### Resolved", "");
      for (const r of report.resolved) lines.push(`- **${r.id}**: gone since ${report.previous.week}; last value ${r.metric.value} ${r.metric.unit} (${r.metric.name})`, ...r.changes.map(changeLine));
    }
    if (report.unknown.length > 0) {
      lines.push("", "### Unknown (not measured this week)", "");
      for (const r of report.unknown) lines.push(`- **${r.id}**: cannot be judged; last value in ${report.previous.week} ${r.metric.value} ${r.metric.unit} (${r.metric.name})`, ...r.changes.map(changeLine));
    }
    if (report.otherChanges.length > 0) {
      lines.push("", "### Changes without a listed finding", "");
      for (const c of report.otherChanges) lines.push(`- **${c.finding}**`, changeLine(c));
    }
    return lines;
  };
  if (report.empty) {
    const hasFindings = report.findings.length + report.resolved.length + report.unknown.length + report.otherChanges.length > 0;
    return [...out, "", ...(hasFindings ? [...findingsMd(), ""] : []), ...coverageMd(), ""].join("\n");
  }

  const t = report.tables;
  out.push(
    "",
    "## Share of the windows",
    "",
    report.hasWindowData
      ? `Points of the 5h and 7d windows, this week against ${report.previous.week}${report.previous.hasWindowData ? "" : " (no quota readings there: no delta)"}. The sessions column counts the Claude Code sessions active in the week, with 0 points when none was attributed.`
      : "No quota readings this week: the points are unknown, so only the session counts are shown.",
    "",
    shareMd("By lane", "lane", t.lane),
    "",
    shareMd("By factory role", "role", t.role),
    "",
    shareMd("By subagent type", "subagent type", t.subagentType),
    "",
    "### By skill",
    "",
    "Skills have no window share: a session loads several skills and its points cannot be split between them, so this is loads and characters only (tokens are about characters / 4).",
    "",
  );
  out.push(
    t.skills.length === 0
      ? "(no skill loads)"
      : table(
          ["skill", "loads", "prev", "delta", "chars", "avg chars", "prev avg", "avg delta"],
          t.skills.map((s) => [s.name, fmtInt(s.loads.now), fmtInt(s.loads.prev), fmtIntDelta(s.loads.delta), fmtInt(s.totalChars.now), fmtInt(s.avgChars.now), fmtInt(s.avgChars.prev), fmtIntDelta(s.avgChars.delta)]),
        ),
    "",
    "## Cache hit ratio and compactions by lane",
    "",
    "Claude Code only. The ratio is cache reads over all input tokens, from sums.",
    "",
    t.cache.length === 0
      ? "(no requests)"
      : table(
          ["lane", "requests", "cache ratio", "prev", "delta", "compactions", "prev", "delta", "sessions", "per session"],
          t.cache.map((c) => [c.lane, int(c.requests), fmt(c.cacheHitRatio.now, 3), fmt(c.cacheHitRatio.prev, 3), fmtDelta(c.cacheHitRatio.delta, 3), fmtInt(c.compactions.now), fmtInt(c.compactions.prev), fmtIntDelta(c.compactions.delta), String(c.sessions), fmt(c.compactionsPerSession, 2)]),
        ),
    "",
    "## Top sessions by 7d share (only sessions with attributed points)",
    "",
    t.topSessions.length === 0
      ? "(no sessions)"
      : table(
          ["session", "lane", "role", "repo", "issue", "model", "effort", "account", "5h pts", "7d pts"],
          t.topSessions.map((s) => [s.session, s.lane, s.role, s.repo, s.issue, s.model, s.effort, s.account, fmt(s.fiveHourPts), fmt(s.sevenDayPts)]),
        ),
    "",
  );
  out.push(...findingsMd());
  out.push("", ...coverageMd(), "");
  return out.join("\n");
}

/** `<dir>/<week>.md` and `<dir>/<week>.json`, each written to a temp file and renamed into place. Returns the paths. */
export function writeWeekly(dir: string, report: WeeklyReport): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode does not apply to a directory that already existed
  return [
    [`${report.week}.md`, formatWeekly(report)],
    [`${report.week}.json`, `${JSON.stringify(report, null, 2)}\n`],
  ].map(([name, content]) => {
    const target = join(dir, name as string);
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, content as string, { mode: 0o600 });
    renameSync(tmp, target);
    return target;
  });
}
