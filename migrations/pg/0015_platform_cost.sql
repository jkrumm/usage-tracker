-- The provider's own figure for what each Claude Console org spent, by day, model and API key (agent-workflows
-- docs/gateway.md §Usage and telemetry). Filled by usage-tracker's credit pass from the Admin API
-- (`GET /v1/organizations/analytics/cost`); it reconciles usage.credit_cycles once a cycle has closed.
--
-- cost_usd is the API's `amount` / 100 (cents) at list price, before credits. model and api_key_id are NULL for cost
-- that has neither (web search, Console playground); the unique index coalesces them so a NULL group is one row.
-- refreshed_at is the response's `data_refreshed_at`: the provider's snapshot the figure came from. Values are revised
-- until about 7 days after month end, so the pass re-queries a trailing window and upserts.
CREATE TABLE usage.platform_cost (
  account       text        NOT NULL,
  day           date        NOT NULL,
  model         text,
  api_key_id    text,
  cost_usd      numeric     NOT NULL,
  refreshed_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX platform_cost_key
  ON usage.platform_cost (account, day, coalesce(model, ''), coalesce(api_key_id, ''));
