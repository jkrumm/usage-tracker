-- Window share, second cut (review of 0011). 0011 paired whole readings, so a reading missing one window's pct lost that
-- window's movement across the gap, one machine's incomplete reading could shadow another's complete one, and a fresh
-- window's start was taken from the previous reading's resets_at even when several windows had passed. The views are
-- rebuilt with the same columns: readings are unpivoted per window first (a reading without pct or resets_at is not a
-- reading of that window), collapsed per (account, window, sampled_at) to a complete one, then paired per window; a
-- fresh window starts at its own resets_at minus its length (5 h / 7 d), not at the previous window's end.
DROP VIEW usage.session_window_share;
DROP VIEW usage.window_attribution;
DROP VIEW usage.window_intervals;

-- window_intervals: see docs/usage-schema.md §Window share. Note the collector stamps both windows of a reading with the
-- fresher window's age (sampled_at = now - min(window ages)), so a window observed earlier than the other is dated late.
CREATE VIEW usage.window_intervals AS
WITH readings AS (
  SELECT DISTINCT ON (q.account, v.win, q.sampled_at)
         q.account, v.win, q.sampled_at, v.pct, v.resets_at, v.len
  FROM usage.quota_samples q
  CROSS JOIN LATERAL (VALUES
    ('five_hour', q.five_hour_pct, q.five_hour_resets_at, interval '5 hours'),
    ('seven_day', q.seven_day_pct, q.seven_day_resets_at, interval '7 days')
  ) AS v(win, pct, resets_at, len)
  WHERE v.pct IS NOT NULL AND v.resets_at IS NOT NULL
  ORDER BY q.account, v.win, q.sampled_at, q.machine
),
paired AS (
  SELECT account, win, len, sampled_at AS to_at, pct, resets_at,
         lag(sampled_at) OVER w AS prev_at, lag(pct) OVER w AS prev_pct, lag(resets_at) OVER w AS prev_resets_at
  FROM readings
  WINDOW w AS (PARTITION BY account, win ORDER BY sampled_at)
),
deltas AS (
  SELECT account, win, to_at,
         abs(extract(epoch FROM resets_at - prev_resets_at)) > 60 AS fresh_window,
         CASE WHEN abs(extract(epoch FROM resets_at - prev_resets_at)) > 60
              THEN greatest(prev_at, least(resets_at - len, to_at)) ELSE prev_at END AS from_at,
         CASE WHEN abs(extract(epoch FROM resets_at - prev_resets_at)) > 60
              THEN pct ELSE greatest(pct - prev_pct, 0) END AS delta_pct
  FROM paired
  WHERE prev_at IS NOT NULL
)
SELECT d.account, d.win, d.from_at, d.to_at, d.delta_pct, d.fresh_window,
       coalesce(r.cost, 0) AS records_cost, coalesce(r.n, 0) AS records_n
FROM deltas d
LEFT JOIN LATERAL (
  SELECT sum(cost_usd) AS cost, count(*) AS n
  FROM usage.records
  WHERE billing = 'max' AND account = d.account AND ts > d.from_at AND ts <= d.to_at
) r ON true
WHERE d.delta_pct > 0;

CREATE VIEW usage.window_attribution AS
SELECT i.account, i.win, i.to_at, r.session_id,
       sum(r.cost_usd) AS cost_usd,
       i.delta_pct * sum(r.cost_usd) / i.records_cost AS share_pct
FROM usage.window_intervals i
JOIN usage.records r
  ON r.billing = 'max' AND r.account = i.account AND r.ts > i.from_at AND r.ts <= i.to_at AND r.cost_usd > 0
WHERE i.records_cost > 0
GROUP BY i.account, i.win, i.to_at, i.delta_pct, i.records_cost, r.session_id;

CREATE VIEW usage.session_window_share AS
SELECT account, session_id,
       coalesce(sum(share_pct) FILTER (WHERE win = 'five_hour'), 0) AS five_hour_pct,
       coalesce(sum(share_pct) FILTER (WHERE win = 'seven_day'), 0) AS seven_day_pct
FROM usage.window_attribution
GROUP BY account, session_id;
