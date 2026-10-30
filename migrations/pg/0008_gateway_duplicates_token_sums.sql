-- 0007's rule compared the token columns one by one; the two stores split them differently (the gateway's own push lumps
-- reasoning into output_tokens, the collector keeps it apart: 871 + 3898 reasoning = 4769 output for the same
-- gemini-3.8-flash call). Priced they are the same call, so the rule now compares output + reasoning and the two cache
-- writes as sums. Replaces the function and runs it again (idempotent: rows already marked stay as they are).

CREATE OR REPLACE FUNCTION usage.flag_gateway_duplicates() RETURNS bigint
LANGUAGE sql AS $$
  WITH g AS (
    SELECT *, output_tokens + reasoning_tokens AS out_all, cache_write_5m_tokens + cache_write_1h_tokens AS write_all
    FROM usage.records
    WHERE billing = 'api_key' AND model IS NOT NULL
      AND source IN ('audio-gateway', 'audio-gateway-mini', 'audio-gateway-vps', 'image-gen-gateway', 'image-gateway')
      AND input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + reasoning_tokens > 0
  ), pairs AS (
    SELECT b.id AS record_id, min(a.id) AS duplicate_of
    FROM g a JOIN g b
      ON a.id < b.id
     AND a.api_key IS NOT DISTINCT FROM b.api_key
     AND a.model = b.model
     AND a.input_tokens = b.input_tokens AND a.out_all = b.out_all
     AND a.cache_read_tokens = b.cache_read_tokens AND a.write_all = b.write_all
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
