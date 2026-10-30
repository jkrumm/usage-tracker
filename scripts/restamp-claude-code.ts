#!/usr/bin/env bun
import { claudeCodeCollector } from "../src/collectors/claude-code.ts";
import { backfillEvents, runIngest } from "../src/ingest.ts";
import { connect } from "../src/pg/connect.ts";

// Re-stamp the Claude Code attribution (effort, subagent sessions and parent links, factory role, lane) of the rows already
// in usage.records, and (re)emit its session events (compactions, skill loads: usage.session_events, idempotent): a full re-scan of the transcripts through the normal writer, so the rows are rewritten in place. Costs
// are not supposed to move (same tokens, same prices): a fingerprint of every record's id and cost is taken before and
// after and the run exits 1 when it differs (rows of the run's own time excluded). Afterwards the span of every claude-code session is recomputed from its
// records, because subagent requests that moved into their own sessions had widened their parent's span.
//
//   make uninstall-agent && make restamp-claude-code && make deploy      (idempotent: a failed run is simply run again)
//
// `--events-only` (make backfill-events) is the way to backfill compactions and skill loads: a full scan whose records are
// discarded, only usage.session_events is written, the collector's cursor and run state are not touched, and the ingest
// LaunchAgent may stay loaded. The full restamp above is for attribution changes only.

if (process.argv.includes("--events-only")) {
  const sql = connect();
  try {
    const r = await backfillEvents(sql, claudeCodeCollector);
    const kinds = Object.entries(r.byKind).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(`events: ${r.seen} seen (${kinds || "none"}), ${r.written} written`);
  } finally {
    await sql.close();
  }
  process.exit(0);
}

const AGENT_LABEL = "com.jkrumm.usage-tracker";
// The ingest agent rewrites the same keys and saves the cursor this run saves: stop it first (`make uninstall-agent`), `make deploy` after.
const loaded = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (loaded && !process.argv.includes("--force")) {
  console.error(`restamp: refusing, the ingest LaunchAgent ${AGENT_LABEL} is loaded (make uninstall-agent first, make deploy after; --force overrides)`);
  process.exit(1);
}

const sql = connect();
// Only rows older than the run: transcript lines written while it runs are new rows, not a cost change.
const cutoff = new Date().toISOString();
const FINGERPRINT = `
  SELECT count(*)::int AS n, coalesce(sum(cost_usd), 0)::text AS total,
         md5(string_agg(concat_ws(':', source_id, cost_usd, cost_source, billing, account, api_key), ',' ORDER BY source_id)) AS hash
  FROM usage.records WHERE source = 'claude-code' AND ts < '${cutoff}'`;
try {
  const [before] = await sql.unsafe(FINGERPRINT);
  console.log(`before: ${before.n} records, cost ${before.total}`);

  const summary = await runIngest(sql, { full: true, only: "claude-code" });
  for (const r of summary.results) console.log(`${r.source}: ${r.status} +${r.newRows} new / ${r.processed} seen${r.note ? ` (${r.note})` : ""}`);
  // A skipped or failed collector is an incomplete restamp. A note (the MacBook asleep: its mirror on disk is still scanned) is a warning.
  if (summary.results.some((r) => r.status !== "ok")) {
    console.error("restamp: the scan did not complete; fix the cause above and run again (idempotent)");
    process.exit(1);
  }

  const spans = await sql.unsafe(`
    UPDATE usage.sessions s SET first_ts = a.mn, last_ts = a.mx
    FROM (SELECT session_id, min(ts) AS mn, max(ts) AS mx FROM usage.records WHERE source = 'claude-code' AND session_id IS NOT NULL GROUP BY session_id) a
    WHERE s.id = a.session_id AND s.source = 'claude-code' AND (s.first_ts, s.last_ts) IS DISTINCT FROM (a.mn, a.mx)`);
  const [empty] = await sql.unsafe(`
    SELECT count(*)::int AS n FROM usage.sessions s
    WHERE s.source = 'claude-code' AND NOT EXISTS (SELECT 1 FROM usage.records r WHERE r.session_id = s.id)`);
  console.log(`session spans recomputed: ${spans.count}; claude-code sessions without records: ${empty.n}`);

  const [after] = await sql.unsafe(FINGERPRINT);
  console.log(`after:  ${after.n} records, cost ${after.total}`);
  if (before.hash === after.hash) console.log("cost fingerprint: unchanged");
  else {
    console.log(`cost fingerprint: DIFFERS (records ${before.n} -> ${after.n}, cost ${before.total} -> ${after.total})`);
    process.exit(1);
  }
} finally {
  await sql.close();
}
