-- Window share (decision U5, docs/usage-schema.md §Window share). Views only, nothing stored.
--
-- window_intervals: per account and window ('five_hour' | 'seven_day'), each pair of consecutive quota readings is one
-- interval (from_at, to_at] that moved the window by delta_pct points.
--   * same window (resets_at within 60 s: the statusline jitters it, 15:59:59 vs 16:00:00): delta = pct - prev pct,
--     floored at 0; from_at = the previous reading.
--   * moved resets_at = a fresh window: its baseline is 0, delta = pct, and only records after the old window's end
--     (prev resets_at, bounded to the interval) can have caused it. The old window's unobserved tail is not attributed.
--   * a reading missing its pct or resets_at, or the account's first reading, yields no interval.
-- records_cost / records_n are the Max records of that account inside the interval; records_cost = 0 means the window
-- moved with nothing to blame (the residual: MacBook mirror lag, a machine we do not collect).
CREATE VIEW usage.window_intervals AS
WITH series AS (
  -- Machines of one account read the same window; one reading per (account, sampled_at).
  SELECT DISTINCT ON (account, sampled_at)
         account, sampled_at, five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at
  FROM usage.quota_samples
  ORDER BY account, sampled_at, machine
),
paired AS (
  SELECT account, sampled_at AS to_at, lag(sampled_at) OVER w AS prev_at,
         five_hour_pct, lag(five_hour_pct) OVER w AS prev_five_hour_pct,
         five_hour_resets_at, lag(five_hour_resets_at) OVER w AS prev_five_hour_resets_at,
         seven_day_pct, lag(seven_day_pct) OVER w AS prev_seven_day_pct,
         seven_day_resets_at, lag(seven_day_resets_at) OVER w AS prev_seven_day_resets_at
  FROM series
  WINDOW w AS (PARTITION BY account ORDER BY sampled_at)
),
per_window AS (
  SELECT p.account, v.win, p.prev_at, p.to_at, v.pct, v.prev_pct, v.resets_at, v.prev_resets_at,
         abs(extract(epoch FROM v.resets_at - v.prev_resets_at)) > 60 AS fresh_window
  FROM paired p
  CROSS JOIN LATERAL (VALUES
    ('five_hour', p.five_hour_pct, p.prev_five_hour_pct, p.five_hour_resets_at, p.prev_five_hour_resets_at),
    ('seven_day', p.seven_day_pct, p.prev_seven_day_pct, p.seven_day_resets_at, p.prev_seven_day_resets_at)
  ) AS v(win, pct, prev_pct, resets_at, prev_resets_at)
  WHERE p.prev_at IS NOT NULL
    AND v.pct IS NOT NULL AND v.prev_pct IS NOT NULL AND v.resets_at IS NOT NULL AND v.prev_resets_at IS NOT NULL
),
deltas AS (
  SELECT account, win, to_at, fresh_window,
         CASE WHEN fresh_window THEN greatest(prev_at, least(prev_resets_at, to_at)) ELSE prev_at END AS from_at,
         CASE WHEN fresh_window THEN pct ELSE greatest(pct - prev_pct, 0) END AS delta_pct
  FROM per_window
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

-- window_attribution: each interval's delta split over the sessions with priced Max records in it, in proportion to
-- cost_usd. Per interval the shares sum to delta_pct exactly; intervals with no priced record stay in window_intervals
-- as residual. share_pct is in points of the window (3.2 = 3.2 % of the 5 h or 7 d window).
CREATE VIEW usage.window_attribution AS
SELECT i.account, i.win, i.to_at, r.session_id,
       sum(r.cost_usd) AS cost_usd,
       i.delta_pct * sum(r.cost_usd) / i.records_cost AS share_pct
FROM usage.window_intervals i
JOIN usage.records r
  ON r.billing = 'max' AND r.account = i.account AND r.ts > i.from_at AND r.ts <= i.to_at AND r.cost_usd > 0
WHERE i.records_cost > 0
GROUP BY i.account, i.win, i.to_at, i.delta_pct, i.records_cost, r.session_id;

-- session_window_share: a session's window share = the sum of its attributed deltas, per window. A subagent is a session
-- of its own (parent_session_id links it); a tree's share is the sum over a session and its children.
CREATE VIEW usage.session_window_share AS
SELECT account, session_id,
       coalesce(sum(share_pct) FILTER (WHERE win = 'five_hour'), 0) AS five_hour_pct,
       coalesce(sum(share_pct) FILTER (WHERE win = 'seven_day'), 0) AS seven_day_pct
FROM usage.window_attribution
GROUP BY account, session_id;
