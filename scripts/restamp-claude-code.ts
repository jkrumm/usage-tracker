#!/usr/bin/env bun
import { runIngest } from "../src/ingest.ts";
import { connect } from "../src/pg/connect.ts";

// Re-stamp the Claude Code attribution (effort, subagent sessions and parent links, factory role, lane) of the rows already
// in usage.records: a full re-scan of the transcripts through the normal writer, so the rows are rewritten in place. Costs
// are not supposed to move (same tokens, same prices): a fingerprint of every record's id and cost is taken before and
// after and the run exits 1 when it differs (rows of the run's own time excluded). Afterwards the span of every claude-code session is recomputed from its
// records, because subagent requests that moved into their own sessions had widened their parent's span.
//
//   bun scripts/restamp-claude-code.ts          (make restamp-claude-code)

const sql = connect();
// Only rows older than the run: transcript lines written while it runs are new rows, not a cost change.
const cutoff = new Date().toISOString();
const FINGERPRINT = `
  SELECT count(*)::int AS n, coalesce(sum(cost_usd), 0)::text AS total,
         md5(string_agg(source_id || ':' || coalesce(cost_usd::text, 'null') || ':' || cost_source, ',' ORDER BY source_id)) AS hash
  FROM usage.records WHERE source = 'claude-code' AND ts < '${cutoff}'`;
try {
  const [before] = await sql.unsafe(FINGERPRINT);
  console.log(`before: ${before.n} records, cost ${before.total}`);

  const summary = await runIngest(sql, { full: true, only: "claude-code" });
  for (const r of summary.results) console.log(`${r.source}: ${r.status} +${r.newRows} new / ${r.processed} seen${r.note ? ` (${r.note})` : ""}`);
  if (summary.results.some((r) => r.status === "error")) process.exit(1);

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
