-- 0007/0008 paired by `b.id -> min(a.id) over every earlier match`, which is not one-to-one: a row could be the `b` of one match
-- and the `a` of another, so two distinct identical-token calls within 10 s that were both mirrored (X_a, Y_a, X_b, Y_b)
-- flagged three rows (Y_a as a copy of X_a, X_b as a copy of Y_a, Y_b as a copy of X_b or Y_a), one of them a real call.
--
-- The rule now matches strictly per store pair. Rows are walked in (ts, id) order; a still-free row opens a call and takes,
-- from every OTHER (source, machine) store, the earliest free later row of the same signature (same key, model, input,
-- output + reasoning, cache read, cache writes as a sum) within 10 s: at most one row per store, so two calls of one store
-- never merge, and every row belongs to exactly one call. In a call of n rows the lowest id is kept (as before) and the
-- other n - 1 are marked. A row is therefore never both an original and a duplicate, and in the interleaved case
-- (X_a, Y_a, X_b, Y_b) exactly two rows are marked. Calls of three stores (the audio gateway, its mirror and the image
-- gateway's own push recorded the same gpt-image-2 call: 22 rows, $0.86 on the live data) keep both extra copies marked,
-- which a strict "one pair per row" rule would put back into the totals.
--
-- Rows already in record_duplicates (either column) are skipped, which keeps the function idempotent and lets it run after
-- a backfill without disturbing earlier calls. This migration drops the marks 0007/0008 wrote and recomputes them with the
-- new rule, because the over-marked rows would otherwise stay. usage.records is untouched; "undoing" stays
-- DELETE FROM usage.record_duplicates.

CREATE OR REPLACE FUNCTION usage.flag_gateway_duplicates() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  x record;
  partners bigint[];
  keeper bigint;
  inserted bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.gateway_free;
  DROP TABLE IF EXISTS pg_temp.gateway_pairs;

  CREATE TEMP TABLE gateway_free ON COMMIT DROP AS
    SELECT r.id, r.ts, r.source, r.machine, r.api_key, r.model, r.input_tokens,
           r.output_tokens + r.reasoning_tokens AS out_all, r.cache_read_tokens,
           r.cache_write_5m_tokens + r.cache_write_1h_tokens AS write_all, false AS used
    FROM usage.records r
    WHERE r.billing = 'api_key' AND r.model IS NOT NULL
      AND r.source IN ('audio-gateway', 'audio-gateway-mini', 'audio-gateway-vps', 'image-gen-gateway', 'image-gateway')
      AND r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_5m_tokens + r.cache_write_1h_tokens + r.reasoning_tokens > 0
      AND NOT EXISTS (SELECT 1 FROM usage.record_duplicates d WHERE d.record_id = r.id OR d.duplicate_of = r.id);
  CREATE UNIQUE INDEX ON gateway_free (id);
  CREATE INDEX ON gateway_free (model, input_tokens, ts);
  CREATE TEMP TABLE gateway_pairs (original_id bigint, duplicate_id bigint) ON COMMIT DROP;

  FOR x IN SELECT * FROM gateway_free ORDER BY ts, id LOOP
    CONTINUE WHEN (SELECT f.used FROM gateway_free f WHERE f.id = x.id);
    SELECT array_agg(p.id) INTO partners
    FROM (
      SELECT DISTINCT ON (y.source, y.machine) y.id
      FROM gateway_free y
      WHERE NOT y.used
        AND y.model = x.model AND y.input_tokens = x.input_tokens
        AND y.api_key IS NOT DISTINCT FROM x.api_key
        AND y.out_all = x.out_all AND y.cache_read_tokens = x.cache_read_tokens AND y.write_all = x.write_all
        AND (y.ts, y.id) > (x.ts, x.id)
        AND y.ts <= x.ts + interval '10 seconds'
        AND (y.source, y.machine) IS DISTINCT FROM (x.source, x.machine)
      ORDER BY y.source, y.machine, y.ts, y.id
    ) p;
    CONTINUE WHEN partners IS NULL;
    UPDATE gateway_free SET used = true WHERE id = x.id OR id = ANY (partners);
    SELECT min(m) INTO keeper FROM unnest(partners || x.id) AS m;
    INSERT INTO gateway_pairs SELECT keeper, m FROM unnest(partners || x.id) AS m WHERE m <> keeper;
  END LOOP;

  INSERT INTO usage.record_duplicates (record_id, duplicate_of, rule)
  SELECT p.duplicate_id, p.original_id, 'gateway-mirror' FROM gateway_pairs p
  ON CONFLICT (record_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END
$$;

DELETE FROM usage.record_duplicates WHERE rule = 'gateway-mirror';
SELECT usage.flag_gateway_duplicates();
