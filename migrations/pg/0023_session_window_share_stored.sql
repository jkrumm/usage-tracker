-- session_window_share took ~12 s per read (issue 446): window_attribution joined every Max record of an account against
-- every interval and removed 353 million rows by the range filter (r.ts between from_at and to_at) before grouping, and no
-- session filter could reach it, because each interval's records_cost needs all of its records.
--
--   1. window_attribution (same columns, same rows) reads each interval's records through the (account, ts) index, one
--      lateral aggregate per interval: ~13 s -> ~1 s. window / weekly read this view and get the same speed-up.
--   2. session_window_share becomes a MATERIALIZED view over it (same columns: account, session_id, five_hour_pct,
--      seven_day_pct). A filtered read is an index lookup. `ingest` refreshes it (REFRESH ... CONCURRENTLY, so readers
--      never block) after the collectors and the repair pass, every run (src/pg/window-share.ts); it is at most one ingest
--      interval (15 min) behind usage.records / quota_samples.
--
-- The unique index is what CONCURRENTLY needs; NULLS NOT DISTINCT because records without a session group under a NULL.
-- DROP VIEW loses the factory role's grant (0022), so it is repeated here with the same guard.

CREATE OR REPLACE VIEW usage.window_attribution AS
SELECT i.account, i.win, i.to_at, r.session_id,
       r.cost_usd,
       i.delta_pct * r.cost_usd / i.records_cost AS share_pct
FROM usage.window_intervals i
CROSS JOIN LATERAL (
  SELECT session_id, sum(cost_usd) AS cost_usd
  FROM usage.records
  WHERE billing = 'max' AND account = i.account AND ts > i.from_at AND ts <= i.to_at AND cost_usd > 0
  GROUP BY session_id
) r
WHERE i.records_cost > 0;

DROP VIEW usage.session_window_share;

CREATE MATERIALIZED VIEW usage.session_window_share AS
SELECT account, session_id,
       coalesce(sum(share_pct) FILTER (WHERE win = 'five_hour'), 0) AS five_hour_pct,
       coalesce(sum(share_pct) FILTER (WHERE win = 'seven_day'), 0) AS seven_day_pct
FROM usage.window_attribution
GROUP BY account, session_id;

CREATE UNIQUE INDEX session_window_share_key ON usage.session_window_share (account, session_id) NULLS NOT DISTINCT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory') THEN
    GRANT SELECT ON usage.session_window_share TO factory;
  ELSE
    RAISE NOTICE 'role factory does not exist: 0023 granted nothing; create the role first, then add a migration repeating this grant';
  END IF;
END
$$;
