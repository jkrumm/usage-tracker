-- The three DeepSeek supersede rows of 0005 lose to the catalog (Wave 2 step 4, docs/reconciliation/2026-10-30-portal-actuals.md).
-- Measured against IU's portal over 2026-09-26..10-30 (base cost at peak rates per day/hour/weekday from the stored tokens, then a
-- window hypothesis, summed per portal day): deepseek-v4.1-flash catalog schedule 0.96x of the portal vs 1.39x with the 16:30-00:30
-- window; deepseek-v4-pro 0.89x vs 1.18x; deepseek-v4-flash 1.53x on 7 days / $2.72, too thin to fit, so it follows the catalog too.
-- 0005 is applied and never edited: this deletes its rows, and the catalog entries they shadowed price these models again.
DELETE FROM usage.price_overrides
WHERE supersedes_prices
  AND model IN ('deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash')
  AND valid_from = '2026-01-01T00:00:00Z';
