-- Gateway mirror duplicates (Wave 2 step 4, docs/reconciliation/2026-10-30-portal-actuals.md).
--
-- The audio gateway (and the image gateways behind it) were recorded twice: by the usage-tracker collector that read the
-- gateway's own log, and by the gateway's own push to Argo (sources audio-gateway-mini / audio-gateway-vps, or audio-gateway
-- with another machine label). The backfill carried both stores into usage.records, so one call is two rows with the same
-- key, model, five token counts and a timestamp within seconds. Measured against IU's portal the second copy is a double
-- count (claude-opus-4-6 tracked exactly 2.00x the portal on 2026-09-28 and 10-19, claude-opus-5-5 on 10-24 matches the
-- portal to the cent once one copy is dropped).
--
-- Rows are never deleted. record_duplicates marks the later copy of a pair, records_unique is the view without the marked
-- rows, and "undoing" is DELETE FROM usage.record_duplicates. The sources are retired, so the rule only has to run once;
-- flag_gateway_duplicates() is idempotent and can be re-run after a backfill.

CREATE TABLE usage.record_duplicates (
  record_id    bigint      PRIMARY KEY REFERENCES usage.records (id) ON DELETE CASCADE,
  duplicate_of bigint      NOT NULL REFERENCES usage.records (id) ON DELETE CASCADE,
  rule         text        NOT NULL,
  flagged_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (record_id <> duplicate_of)
);
CREATE INDEX record_duplicates_of_idx ON usage.record_duplicates (duplicate_of);

-- Every record except the flagged copies. Selects r.* as of creation: a new records column needs this view recreated.
CREATE VIEW usage.records_unique AS
SELECT r.* FROM usage.records r
WHERE NOT EXISTS (SELECT 1 FROM usage.record_duplicates d WHERE d.record_id = r.id);

-- Rule 'gateway-mirror': two api_key rows of the gateway family, from different (source, machine) pairs, with the same
-- key, model and all six token counts (not all zero), at most 10 seconds apart. The lower id is the one kept.
CREATE FUNCTION usage.flag_gateway_duplicates() RETURNS bigint
LANGUAGE sql AS $$
  WITH g AS (
    SELECT * FROM usage.records
    WHERE billing = 'api_key' AND model IS NOT NULL
      AND source IN ('audio-gateway', 'audio-gateway-mini', 'audio-gateway-vps', 'image-gen-gateway', 'image-gateway')
      AND input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + reasoning_tokens > 0
  ), pairs AS (
    SELECT b.id AS record_id, min(a.id) AS duplicate_of
    FROM g a JOIN g b
      ON a.id < b.id
     AND a.api_key IS NOT DISTINCT FROM b.api_key
     AND a.model = b.model
     AND a.input_tokens = b.input_tokens AND a.output_tokens = b.output_tokens
     AND a.cache_read_tokens = b.cache_read_tokens
     AND a.cache_write_5m_tokens = b.cache_write_5m_tokens AND a.cache_write_1h_tokens = b.cache_write_1h_tokens
     AND a.reasoning_tokens = b.reasoning_tokens
     AND a.ts BETWEEN b.ts - interval '10 seconds' AND b.ts + interval '10 seconds'
     AND (a.source, a.machine) IS DISTINCT FROM (b.source, b.machine)
    GROUP BY b.id
  ), ins AS (
    INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
    SELECT record_id, duplicate_of, 'gateway-mirror' FROM pairs
    ON CONFLICT (record_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins
$$;

SELECT usage.flag_gateway_duplicates();
