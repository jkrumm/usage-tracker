-- IU-specific price facts of the retired src/pricing.ts, as usage.price_overrides (Wave 2 step 3).
--
-- Derived mechanically: every PRICING entry was compared with the catalog schedule in force on 2026-10-30
-- (usage.prices through usage.price_aliases, effective rates after the cache fallbacks, tiers and off-peak
-- windows). Entries the catalog already prices identically get no row; the differences are below.
--
--   supersedes_prices = true   a rate IU measured against its own gateway `usage.cost`, or a window the catalog
--                              disagrees with: it beats the catalog at every time in [valid_from, valid_to).
--   supersedes_prices = false  a list-price carry-over for a model the catalog has no key for: it fills the gap,
--                              and a catalog entry added later wins.
--
-- An override replaces the whole schedule, so each row states what applies: no tiers, and off_peak only where
-- IU measured one. cache_write_5m / cache_write_1h stay NULL where cache writes bill as ordinary input (the
-- Requesty-routed models: the gateway never reports a cache-creation field); compute_cost falls back to input.
-- valid_from 2026-01-01 precedes the first record, so the rates cover the whole history, as pricing.ts did.
--
-- Not carried over: the FAMILY_PRICING tier fallback (an unpriced Claude id is NULL until the catalog prices it),
-- free local models (gemma4-agent: an override cannot be 0, so it stays cost_source 'none'), and the models the
-- catalog prices identically (claude-*, gpt-5.6/6 families, kimi-k2.6, glm-5.3-flash, minimax-m3, sonar, gemini-3.5/3.8-flash,
-- gpt-5-mini, gpt-5.4-mini). IGNORE_REPORTED_COST (sonar) and REASONING_FREE_BEFORE (gpt-5.6-terra) are
-- writer rules (src/pg/writer.ts), not prices.
-- Forward-only: once applied, a correction is a new migration or a row with a later valid_from.

INSERT INTO usage.price_overrides
  (model, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, tiers, off_peak, supersedes_prices, reason)
VALUES
  -- IU unified endpoint, Requesty-routed, EU-resident. Measured 2026-08-28 against the gateway's usage.cost: least
  -- squares over four request shapes per model, 0.0% residual, route-independent (/openai and /anthropic agree).
  ('deepseek-v4-pro', '2026-01-01T00:00:00Z', 1.32, 3.96, 0.044, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28 (least squares over four request shapes, 0.0% residual); cache write bills as input. The catalog prices the same base rates but adds weekday/weekend off-peak windows IU was never measured to apply to this model.'),
  ('deepseek-v4-flash', '2026-01-01T00:00:00Z', 0.44, 1.32, 0.014, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28 (least squares over four request shapes, 0.0% residual); the catalog (DeepSeek first-party) lists 0.30/1.20/0.006 and off-peak windows; cache write bills as input.'),
  ('hy3', '2026-01-01T00:00:00Z', 0.14, 0.58, 0.035, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; the catalog (OpenRouter) lists 0.132/0.528/0.033 plus a 16:00-00:00 off-peak window; cache write bills as input.'),
  ('kimi-k2.7-code', '2026-01-01T00:00:00Z', 0.95, 4.0, 0.19, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; the catalog (OpenRouter) lists 0.56/3.10/0.15; cache write bills as input.'),
  ('glm-5.1', '2026-01-01T00:00:00Z', 1.4, 4.4, 0.26, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; cache write bills as input.'),
  ('glm-5.2', '2026-01-01T00:00:00Z', 1.4, 4.4, 0.14, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; cache write bills as input.'),
  ('mimo-v2.5-pro', '2026-01-01T00:00:00Z', 1.0, 3.0, 0.2, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; cache write bills as input.'),
  ('nvidia-nemotron-3-super-120b-a12b', '2026-01-01T00:00:00Z', 0.1, 0.5, 0.1, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; no caching observed on the gateway, so cache_read = input on purpose.'),
  ('nemotron-3-ultra', '2026-01-01T00:00:00Z', 0.6, 2.4, 0.12, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; cache write bills as input.'),
  ('qwen3.7-max', '2026-01-01T00:00:00Z', 2.5, 7.5, 2.5, NULL, NULL, NULL, NULL, true,
   'IU gateway usage.cost, measured 2026-08-28; no catalog key; no caching observed on the gateway, so cache_read = input on purpose.'),

  -- deepseek-v4.1-flash resolves to the catalog key deepseek/deepseek-v4-flash, whose base rates agree with IU
  -- (0.30/1.20/0.006) but whose off-peak windows (weekdays 00-01, 04-06, 10-24 UTC; weekends all day) do not.
  -- IU measurements: 2026-09-24 ~18:50Z off-peak, 2026-09-25 06:46Z peak, 2026-09-25 17:17Z off-peak (exactly half
  -- of peak, solved with 0 residual). The window 16:30-00:30 UTC daily is DeepSeek's published one; the
  -- boundaries were not probed.
  ('deepseek-v4.1-flash', '2026-01-01T00:00:00Z', 0.3, 1.2, 0.006, NULL, NULL, NULL,
   '{"rates":{"input":0.15,"output":0.6,"cache_read":0.003},"windows":[{"weekdays":[1,2,3,4,5,6,7],"hours_utc":["16:30-00:30"]}]}'::jsonb,
   true,
   'IU gateway usage.cost, measured 2026-09-24/25 (peak 06:46Z, off-peak 17:17Z and ~18:50Z, 0 residual); off-peak window 16:30-00:30 UTC daily as published by DeepSeek, boundaries not probed; the catalog entry it aliases to carries different windows; cache write bills as input.'),

  -- List-price carry-overs for models the catalog has no key for (OpenAI and Google pricing tables, May and
  -- September 2026). Not IU-measured, so a catalog entry added later takes over.
  ('gemini-3-pro-preview', '2026-01-01T00:00:00Z', 2.0, 12.0, 0.2, NULL, NULL, NULL, NULL, false,
   'List price carried over from pricing.ts (Google, verified May 2026); no catalog key; fills the gap only.'),
  ('gpt-image-2', '2026-01-01T00:00:00Z', 5.0, 30.0, 1.25, NULL, NULL, NULL, NULL, false,
   'List price carried over from pricing.ts (OpenAI): text input and image output tokens mapped to input/output; image input unmodelled; no catalog key; fills the gap only.'),
  ('gpt-image-2.5-flare', '2026-01-01T00:00:00Z', 5.0, 30.0, 1.25, NULL, NULL, NULL, NULL, false,
   'List price carried over from pricing.ts (OpenAI pricing table, verified 2026-09-23), same schedule and mapping as gpt-image-2; no catalog key; fills the gap only.'),
  ('gpt-image-2.5-sunburst', '2026-01-01T00:00:00Z', 5.0, 30.0, 1.25, NULL, NULL, NULL, NULL, false,
   'List price carried over from pricing.ts (OpenAI pricing table, verified 2026-09-23), same schedule and mapping as gpt-image-2; no catalog key; fills the gap only.');
