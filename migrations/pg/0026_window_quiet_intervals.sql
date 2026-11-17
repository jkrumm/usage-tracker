-- Window fit (docs/usage-schema.md §Measured weight per model family). window_intervals lists only intervals that moved a
-- window (delta_pct > 0), which is right for attribution but would bias a regression of points on tokens: the quiet
-- stretches where the meter did not tick (the 7 d meter moves in whole points) are the observations with tokens and
-- zero points, and dropping them inflates every slope. window_quiet_intervals lists them with the same readings, pairing
-- and interval bounds as window_intervals (0012), so window_intervals UNION ALL window_quiet_intervals covers every
-- observed stretch of every window. Nothing stored. The readings / paired / deltas CTEs are copies of 0012's: a change to the
-- pairing or the fresh-window rule must change both views (src/window-fit.test.ts checks that together they cover every pair once).
-- No grant to the factory role: only the fit reads it, as the usage role.
CREATE VIEW usage.window_quiet_intervals AS
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
         CASE WHEN abs(extract(epoch FROM resets_at - prev_resets_at)) > 60
              THEN greatest(prev_at, least(resets_at - len, to_at)) ELSE prev_at END AS from_at,
         CASE WHEN abs(extract(epoch FROM resets_at - prev_resets_at)) > 60
              THEN pct ELSE greatest(pct - prev_pct, 0) END AS delta_pct
  FROM paired
  WHERE prev_at IS NOT NULL
)
SELECT account, win, from_at, to_at FROM deltas WHERE delta_pct = 0;
