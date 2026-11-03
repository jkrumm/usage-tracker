---
# Read by the router (route.py) and by the reviewer. Globs are repo-relative.
none:        [docs/waves/**, docs/backfill/**, docs/reconciliation/**, docs/reports/**, src/prices/fixtures/**, bun.lock]
sensitive:   [migrations/pg/**, src/pg/writer.ts, src/pg/migrate.ts, src/pg/state.ts, src/prices/cost.ts,
              src/prices/sync.ts, src/models.ts, src/iu-keys.ts, src/credit/**, src/reprice.ts,
              src/backfill.ts, scripts/backfill-argo.ts, scripts/restamp-claude-code.ts,
              launchd/*.sh]
nits: 3
---
# REVIEW.md — usage-tracker

What failure looks like here:

- **Cost lies.** `usage.compute_cost` (SQL) and `src/prices/cost.ts` must agree, with the shared fixtures in `cost.test.ts` changed
  together. An unpriced model is NULL / `cost_source='none'`, never 0; `prices-sync` keeps the previous row on a vanished or
  zeroed catalog price. No rate card in code: an IU rate is a new `price_overrides` row in a new migration.
- **A collector decides what only the writer may.** Model normalization, billing, account, lane and IU key are derived in
  `src/pg/writer.ts` / `src/models.ts` (`classifyBilling`, `resolveAccount`) / `src/iu-keys.ts` (`resolveIuKey`), never in
  `src/collectors/*`. A NULL Max account is a collector bug that must stay visible.
- **Spend lands in the wrong class.** `billing` is `max` | `api_key` | `api_credit` | `unknown`; `budget` counts IU `api_key` rows only
  and never `api_credit`; gateway mirror duplicates are marked (`records_unique`), not deleted, and counted once.
- **A migration rewrites history.** Migrations under `migrations/pg` are forward-only and applied files are never edited; the
  `usage` schema is the contract other repos read (`docs/usage-schema.md`). Check lock order, qualified names and backfills.
- **A run aborts or double-counts.** One collector failing must not stop the rest; cursors advance only on success; the upsert
  is idempotent on `(source, source_id)` and moves `ingested_at` on real change only; backfills are insert-only by default.
- **The credit pass miscounts.** `src/credit/` is the only writer of `usage.platform_cost` and `credit_cycles`: hourly
  throttle, accounts isolated from each other, strict response parsing, metered vs reconciled vs unspent.
- **Secrets or key material leak.** Postgres URL and IU keys come through `secrets-run`, never `op`; a key's identity is a label,
  never logged, hashed or sent; no hostnames, IPs or account ids in tracked files, reports or fixtures.

Skip: formatting, naming taste, lint-level remarks, test style. Evidence is always `file:line`.
