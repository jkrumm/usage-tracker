import type { SQL } from "bun";

// `window`: the share of the Max accounts' 5-hour and 7-day windows, by session / lane / role / ... over
// usage.window_attribution (migration 0011; rule in docs/usage-schema.md §Window share). Shares are points of the window
// (3.2 = 3.2 % of one account's 5 h or 7 d window), so a row spanning accounts adds points of different windows.

export type WindowBy = "session" | "lane" | "role" | "subagent_type" | "issue" | "repo" | "account";

/** Whitelisted: the only strings ever spliced into the query. `s` is usage.sessions, `a` usage.window_attribution. */
const BY_EXPR: Record<WindowBy, string> = {
  session: "coalesce(s.source_session_id, '(no session)')",
  lane: "coalesce(s.lane, '(no session)')",
  role: "coalesce(s.lane_detail->>'role', '(none)')",
  subagent_type: "coalesce(s.lane_detail->>'subagent_type', '(none)')",
  issue: "coalesce(s.issue_id, '(none)')",
  repo: "coalesce(s.repo, '(none)')",
  account: "a.account",
};

/** A session is told apart by its database id: source_session_id is unique only within a source. */
const GROUP_EXTRA: Partial<Record<WindowBy, string>> = { session: ", a.session_id" };

export const WINDOW_BY_DIMS = Object.keys(BY_EXPR) as WindowBy[];

export interface WindowRow {
  key: string;
  fiveHourPct: number;
  sevenDayPct: number;
  sessions: number;
}

/** What the window moved in the period against what was attributed; the rest had no priced record to blame. */
export interface WindowCoverage {
  win: "five_hour" | "seven_day";
  movedPts: number;
  attributedPts: number;
  residualPts: number;
}

export interface WindowReport {
  by: WindowBy;
  days: number;
  account: string | null;
  rows: WindowRow[];
  coverage: WindowCoverage[];
}

export async function windowShare(
  sql: SQL,
  opts: { by: WindowBy; days?: number; top?: number; account?: string },
): Promise<WindowReport> {
  const expr = BY_EXPR[opts.by];
  if (!expr) throw new Error(`--by must be one of: ${WINDOW_BY_DIMS.join(", ")}`);
  const days = opts.days ?? 7;
  const top = opts.top ?? 20;
  const account = opts.account ?? null;

  // One snapshot for both reads: an ingest committing between them would make the coverage line disagree with the rows.
  const { rows, coverage } = await sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    const rows = await tx.unsafe(
      `SELECT ${expr} AS key,
              coalesce(sum(a.share_pct) FILTER (WHERE a.win = 'five_hour'), 0)::float8 AS "fiveHourPct",
              coalesce(sum(a.share_pct) FILTER (WHERE a.win = 'seven_day'), 0)::float8 AS "sevenDayPct",
              count(DISTINCT a.session_id)::int AS sessions
       FROM usage.window_attribution a
       LEFT JOIN usage.sessions s ON s.id = a.session_id
       WHERE a.to_at >= now() - $1::float8 * interval '1 day' AND ($2::text IS NULL OR a.account = $2::text)
       GROUP BY 1${GROUP_EXTRA[opts.by] ?? ""}
       ORDER BY "sevenDayPct" DESC, "fiveHourPct" DESC
       LIMIT $3::int`,
      [days, account, top],
    );
    const coverage = await tx`
      SELECT i.win,
             coalesce(sum(i.delta_pct), 0)::float8 AS moved,
             coalesce(sum(i.delta_pct) FILTER (WHERE i.records_cost > 0), 0)::float8 AS attributed
      FROM usage.window_intervals i
      WHERE i.to_at >= now() - ${days}::float8 * interval '1 day' AND (${account}::text IS NULL OR i.account = ${account}::text)
      GROUP BY i.win`;
    return { rows, coverage };
  });
  const byWin = new Map<string, Record<string, unknown>>(coverage.map((c: Record<string, unknown>) => [String(c.win), c]));
  return {
    by: opts.by,
    days,
    account,
    rows: rows as WindowRow[],
    coverage: (["five_hour", "seven_day"] as const).map((win) => {
      const c = byWin.get(win);
      const movedPts = Number(c?.moved ?? 0);
      const attributedPts = Number(c?.attributed ?? 0);
      return { win, movedPts, attributedPts, residualPts: movedPts - attributedPts };
    }),
  };
}

const pts = (n: number) => n.toFixed(1);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-");

export function formatWindow(report: WindowReport): string {
  // No rows can still mean the windows moved with nothing to blame: the coverage lines say so.
  if (report.rows.length === 0 && report.coverage.every((c) => c.movedPts === 0)) return "(no window movement in the period — run `ingest` first)";
  const keyW = Math.min(40, Math.max(report.by.length, ...report.rows.map((r) => r.key.length)));
  const lines = report.rows.length === 0 ? ["(no row: nothing the window moved on has a priced record)"] : [
    [report.by.padEnd(keyW), "5h pts".padStart(9), "7d pts".padStart(9), "sessions".padStart(9)].join("  "),
  ];
  for (const r of report.rows) {
    lines.push(
      [r.key.slice(0, keyW).padEnd(keyW), pts(r.fiveHourPct).padStart(9), pts(r.sevenDayPct).padStart(9), String(r.sessions).padStart(9)].join("  "),
    );
  }
  const scope = `last ${report.days} d${report.account ? `, account ${report.account}` : ""}`;
  lines.push("", `points of the window (${scope}); a row spanning accounts adds points of different windows`);
  for (const c of report.coverage) {
    const label = c.win === "five_hour" ? "5h" : "7d";
    lines.push(`${label} moved ${pts(c.movedPts)}, attributed ${pts(c.attributedPts)}, residual ${pts(c.residualPts)} (${pct(c.residualPts, c.movedPts)}: no priced record in the interval)`);
  }
  return lines.join("\n");
}
