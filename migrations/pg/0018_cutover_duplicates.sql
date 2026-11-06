-- Cutover duplicates: the agw inference gateway (source `gateway`) took over calls that two other stores still report.
-- Rows are marked in usage.record_duplicates (never deleted; records_unique hides them), by two rules, both idempotent:
--
--   gateway-hermes    source `hermes` rows from the first gateway row with caller `hermes` on (2026-11-02): the gateway
--                     reports the same calls (identical cache_read per day). duplicate_of is that first gateway row.
--   gateway-cutover   `agent-workflows` rows whose run_id has a gateway row with status 200 and usageReported true: the
--                     run's calls went through the gateway, which counted them. duplicate_of is the run's first gateway row.
--                     Step `tools` stays: search fees (Tavily, Sonar's request fee) are real spend the gateway never saw.
--
-- Undo: DELETE FROM usage.record_duplicates WHERE rule IN ('gateway-hermes', 'gateway-cutover'). The repair pass calls the
-- function; nothing runs at migrate time.

CREATE FUNCTION usage.flag_cutover_duplicates() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  hermes bigint;
  cutover bigint;
BEGIN
  WITH first_gw AS (
    SELECT id, ts FROM usage.records
    WHERE source = 'gateway' AND lane_detail->>'caller' = 'hermes'
    ORDER BY ts, id LIMIT 1
  )
  INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
  SELECT r.id, f.id, 'gateway-hermes'
  FROM usage.records r JOIN first_gw f ON r.ts >= f.ts
  WHERE r.source = 'hermes'
  ON CONFLICT (record_id) DO NOTHING;
  GET DIAGNOSTICS hermes = ROW_COUNT;

  WITH gw AS (
    SELECT run_id, min(id) AS id FROM usage.records
    WHERE source = 'gateway' AND run_id IS NOT NULL
      AND raw->>'status' = '200' AND raw->>'usageReported' = 'true'
    GROUP BY run_id
  )
  INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
  SELECT r.id, gw.id, 'gateway-cutover'
  FROM usage.records r JOIN gw ON gw.run_id = r.run_id
  WHERE r.source = 'agent-workflows' AND coalesce(r.lane_detail->>'step', '') <> 'tools'
  ON CONFLICT (record_id) DO NOTHING;
  GET DIAGNOSTICS cutover = ROW_COUNT;

  RETURN hermes + cutover;
END
$$;
