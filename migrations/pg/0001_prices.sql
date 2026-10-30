-- Price machinery (decision U3). Every object is schema-qualified: the runner sets no search_path.

-- One row per (catalog model, price schedule). A row is only written when a rate, tier or off-peak value
-- changed, so valid_from is "first seen with these numbers" and the history is effective-dated.
-- Rates are USD per 1M tokens as exact decimals (the catalogs publish per-token floats).
-- A rate that is NULL means "not published": cache_read, cache_write_5m and cache_write_1h fall back to
-- input, input and cache_write_5m at cost time. input/output can never be NULL or <= 0 (never $0 for a
-- model whose price vanished upstream).
CREATE TABLE usage.prices (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_key      text        NOT NULL,   -- catalog key; 'openrouter:<id>' for OpenRouter-sourced models
  valid_from     timestamptz NOT NULL,
  input          numeric     NOT NULL CHECK (input > 0),
  output         numeric     NOT NULL CHECK (output > 0),
  cache_read     numeric     CHECK (cache_read > 0),
  cache_write_5m numeric     CHECK (cache_write_5m > 0),
  cache_write_1h numeric     CHECK (cache_write_1h > 0),
  batch          jsonb,                  -- {input, output, cache_read, cache_write_5m, cache_write_1h}, informational
  tiers          jsonb,                  -- [{above_tokens, input?, output?, cache_read?, cache_write_5m?, cache_write_1h?}]
  off_peak       jsonb,                  -- {rates:{input?, output?, cache_read?, ...}, windows:[{hours_utc:[..], weekdays:[1..7]}]}
  source         text        NOT NULL CHECK (source IN ('litellm', 'openrouter', 'seed-git')),
  source_ref     text,                   -- commit sha (seed-git) or the URL fetched
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, valid_from)
);

-- usage.records.model (or a raw model string) -> catalog key.
CREATE TABLE usage.price_aliases (
  model      text PRIMARY KEY,
  model_key  text NOT NULL,
  matched_by text NOT NULL CHECK (matched_by IN ('exact', 'suffix', 'data', 'manual')),
  note       text
);

-- Manual corrections. By default an override only fills a model the catalog does not price; with
-- supersedes_prices it beats the catalog inside [valid_from, valid_to) (IU-measured rates, a repriced window).
CREATE TABLE usage.price_overrides (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model             text        NOT NULL,   -- a usage model, matched against records.model
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  input             numeric     NOT NULL CHECK (input > 0),
  output            numeric     NOT NULL CHECK (output > 0),
  cache_read        numeric     CHECK (cache_read > 0),
  cache_write_5m    numeric     CHECK (cache_write_5m > 0),
  cache_write_1h    numeric     CHECK (cache_write_1h > 0),
  tiers             jsonb,
  off_peak          jsonb,
  supersedes_prices boolean     NOT NULL DEFAULT false,
  reason            text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX price_overrides_model_idx ON usage.price_overrides (model, valid_from);

-- Is p_ts inside one of the off-peak windows? Hours are UTC "HH:MM-HH:MM" ranges, [start, end). A range whose
-- end is not after its start wraps midnight, so "10:00-00:00" is 10:00 to midnight and "00:00-00:00" is all day.
-- Weekdays are ISO (1 = Monday .. 7 = Sunday).
CREATE FUNCTION usage.in_off_peak(p_off_peak jsonb, p_ts timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  w jsonb;
  h text;
  utc timestamp := p_ts AT TIME ZONE 'UTC';
  dow int := extract(isodow FROM utc)::int;
  minute int := extract(hour FROM utc)::int * 60 + extract(minute FROM utc)::int;
  s int;
  e int;
BEGIN
  IF p_off_peak IS NULL THEN RETURN false; END IF;
  FOR w IN SELECT * FROM jsonb_array_elements(p_off_peak -> 'windows') LOOP
    IF NOT (w -> 'weekdays') @> to_jsonb(dow) THEN CONTINUE; END IF;
    FOR h IN SELECT jsonb_array_elements_text(w -> 'hours_utc') LOOP
      s := split_part(split_part(h, '-', 1), ':', 1)::int * 60 + split_part(split_part(h, '-', 1), ':', 2)::int;
      e := split_part(split_part(h, '-', 2), ':', 1)::int * 60 + split_part(split_part(h, '-', 2), ':', 2)::int;
      IF (s < e AND minute >= s AND minute < e) OR (s >= e AND (minute >= s OR minute < e)) THEN
        RETURN true;
      END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END $$;

-- The applicable schedule for a usage model at a time. Precedence (reported cost is per record, see
-- compute_cost): a superseding override, else the catalog row in force at p_ts, else any override, else no row.
-- A time before the model's first catalog row uses that first row (a model's launch price is the best estimate
-- for its first hours); in_force says which case it was.
CREATE FUNCTION usage.price_at(p_model text, p_ts timestamptz)
RETURNS TABLE (
  origin          text,
  price_id        bigint,
  override_id     bigint,
  in_force        boolean,
  input           numeric,
  output          numeric,
  cache_read      numeric,
  cache_write_5m  numeric,
  cache_write_1h  numeric,
  tiers           jsonb,
  off_peak        jsonb
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  k text := coalesce((SELECT a.model_key FROM usage.price_aliases a WHERE a.model = p_model), p_model);
BEGIN
  RETURN QUERY
    SELECT 'override', NULL::bigint, o.id, true, o.input, o.output, o.cache_read, o.cache_write_5m, o.cache_write_1h, o.tiers, o.off_peak
    FROM usage.price_overrides o
    WHERE o.model = p_model AND o.supersedes_prices AND o.valid_from <= p_ts AND (o.valid_to IS NULL OR p_ts < o.valid_to)
    ORDER BY o.valid_from DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT 'prices', p.id, NULL::bigint, p.valid_from <= p_ts, p.input, p.output, p.cache_read, p.cache_write_5m, p.cache_write_1h, p.tiers, p.off_peak
    FROM usage.prices p
    WHERE p.model_key = k
    ORDER BY (p.valid_from <= p_ts) DESC,
             CASE WHEN p.valid_from <= p_ts THEN p.valid_from END DESC,
             p.valid_from ASC
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT 'override', NULL::bigint, o.id, true, o.input, o.output, o.cache_read, o.cache_write_5m, o.cache_write_1h, o.tiers, o.off_peak
    FROM usage.price_overrides o
    WHERE o.model = p_model AND o.valid_from <= p_ts AND (o.valid_to IS NULL OR p_ts < o.valid_to)
    ORDER BY o.valid_from DESC LIMIT 1;
END $$;

-- Cost of one record. Provider-reported cost wins verbatim; otherwise the schedule from price_at is applied:
-- tier rates replace the base rates of the kinds they list when the prompt (input + cache read + cache write)
-- exceeds the tier's threshold (message grain only: a session row sums many requests); then off-peak rates
-- replace the kinds they list inside a window; then unpublished cache rates fall back (read -> input,
-- write 5m -> input, write 1h -> write 5m). Reasoning tokens bill at the final output rate. An unpriced
-- model yields NULL and cost_source 'none', never 0.
CREATE FUNCTION usage.compute_cost(
  p_model          text,
  p_ts             timestamptz,
  p_input          bigint,
  p_output         bigint,
  p_cache_read     bigint,
  p_cache_write_5m bigint,
  p_cache_write_1h bigint,
  p_reasoning      bigint  DEFAULT 0,
  p_grain          text    DEFAULT 'message',
  p_reported       numeric DEFAULT NULL
)
RETURNS TABLE (cost_usd numeric, cost_source text, price_id bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s record;
  t jsonb;
  r_in numeric; r_out numeric; r_cr numeric; r_w5 numeric; r_w1 numeric;
  prompt bigint := p_input + p_cache_read + p_cache_write_5m + p_cache_write_1h;
  best bigint := -1;
BEGIN
  IF p_reported IS NOT NULL THEN
    RETURN QUERY SELECT p_reported, 'reported', NULL::bigint;
    RETURN;
  END IF;

  SELECT * INTO s FROM usage.price_at(p_model, p_ts);
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::numeric, 'none', NULL::bigint;
    RETURN;
  END IF;

  r_in := s.input; r_out := s.output; r_cr := s.cache_read; r_w5 := s.cache_write_5m; r_w1 := s.cache_write_1h;

  IF p_grain = 'message' AND s.tiers IS NOT NULL THEN
    FOR t IN SELECT * FROM jsonb_array_elements(s.tiers) LOOP
      IF prompt > (t ->> 'above_tokens')::bigint AND (t ->> 'above_tokens')::bigint > best THEN
        best := (t ->> 'above_tokens')::bigint;
        r_in  := coalesce((t ->> 'input')::numeric, s.input);
        r_out := coalesce((t ->> 'output')::numeric, s.output);
        r_cr  := coalesce((t ->> 'cache_read')::numeric, s.cache_read);
        r_w5  := coalesce((t ->> 'cache_write_5m')::numeric, s.cache_write_5m);
        r_w1  := coalesce((t ->> 'cache_write_1h')::numeric, s.cache_write_1h);
      END IF;
    END LOOP;
  END IF;

  IF s.off_peak IS NOT NULL AND usage.in_off_peak(s.off_peak, p_ts) THEN
    t := s.off_peak -> 'rates';
    r_in  := coalesce((t ->> 'input')::numeric, r_in);
    r_out := coalesce((t ->> 'output')::numeric, r_out);
    r_cr  := coalesce((t ->> 'cache_read')::numeric, r_cr);
    r_w5  := coalesce((t ->> 'cache_write_5m')::numeric, r_w5);
    r_w1  := coalesce((t ->> 'cache_write_1h')::numeric, r_w1);
  END IF;

  r_cr := coalesce(r_cr, r_in);
  r_w5 := coalesce(r_w5, r_in);
  r_w1 := coalesce(r_w1, r_w5);

  RETURN QUERY SELECT
    (p_input * r_in + p_output * r_out + p_cache_read * r_cr + p_cache_write_5m * r_w5
       + p_cache_write_1h * r_w1 + p_reasoning * r_out) / 1000000,
    CASE s.origin WHEN 'prices' THEN 'prices' ELSE 'override' END,
    s.price_id;
END $$;
