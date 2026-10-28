// SQLite DDL. Applied idempotently on every open (db.ts), so adding a column
// here means writing a guarded ALTER in db.ts's migrate step — not editing rows.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_record (
  id                 INTEGER PRIMARY KEY,
  source             TEXT    NOT NULL,            -- 'claude-code' | 'hermes' | 'feuer' | 'opencode' | …
  source_id          TEXT    NOT NULL,            -- dedup key within the source
  grain              TEXT    NOT NULL,            -- 'message' | 'session'
  ts                 TEXT    NOT NULL,            -- ISO 8601 UTC event time
  model              TEXT,                        -- raw model string from the source
  model_norm         TEXT,                        -- canonical name used for pricing/grouping
  project            TEXT,                        -- cwd / workspace / channel
  workspace          TEXT,                        -- 'work' | 'private' | NULL (collector-declared or null when Argo classifies)
  sub_tool           TEXT,                        -- e.g. 'check' | 'review' | 'implement' for agent-gateway-attributed rows
  billing            TEXT    NOT NULL,            -- 'max' (sunk) | 'iu' (per-token) | …
  account            TEXT,                        -- Claude Max account id (e.g. 'iu' | 'me' | 'me2') for billing='max' rows, NULL otherwise (account 'iu' != billing 'iu')
  iu_key             TEXT,                        -- IU API key id ('personal' | 'athena-team') for billing='iu' rows, NULL otherwise
  machine            TEXT,                        -- host that produced the record (derived at ingest)
  outcome            TEXT    NOT NULL DEFAULT 'ok', -- 'ok' | 'error' (bridge request outcome)

  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0, -- subset of cache_write_tokens at the 1h TTL
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER,                      -- request/session latency when the source reports it

  cost_usd           REAL,                         -- computed from pricing.ts; NULL if model unpriced
  cost_source        TEXT    NOT NULL DEFAULT 'none', -- 'computed' | 'family' | 'reported' | 'none'

  raw                TEXT,                         -- JSON: source-specific extras
  ingested_at        TEXT    NOT NULL,
  synced_at          TEXT,                         -- set by the Argo remote sync client; NULL = not yet pushed

  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_record (ts);
CREATE INDEX IF NOT EXISTS idx_usage_source  ON usage_record (source);
CREATE INDEX IF NOT EXISTS idx_usage_model   ON usage_record (model_norm);
CREATE INDEX IF NOT EXISTS idx_usage_billing ON usage_record (billing);
-- idx_usage_sub_tool is created in db.ts migrate() so it lands after the
-- guarded ALTER on existing DBs (column doesn't exist on pre-migration tables).

-- One row per collector: its watermark and last-run bookkeeping.
CREATE TABLE IF NOT EXISTS collector_state (
  source         TEXT PRIMARY KEY,
  cursor         TEXT,
  last_run_at    TEXT,
  last_status    TEXT,             -- 'ok' | 'skipped' | 'error'
  last_note      TEXT,
  records_total  INTEGER NOT NULL DEFAULT 0
);

-- claude-code session_env lines (base_url + USAGE_LANE per sessionId), persisted
-- because the hook's log files are pruned after 3 days while herdr sessions run
-- for longer. Filled from the logs by models.ts; the log entry wins on conflict.
CREATE TABLE IF NOT EXISTS session_env (
  session   TEXT PRIMARY KEY,
  base_url  TEXT,
  lane      TEXT,
  account   TEXT,                 -- Claude Max account id from the hook; NULL on pre-account lines
  seen_at   TEXT NOT NULL
);

-- Claude Max account quota history, from "claude-account usage --json".
-- sampled_at = observation time (now - cache age), so an unchanged cached
-- sample re-read on the next run collapses into the same row.
CREATE TABLE IF NOT EXISTS quota_sample (
  account             TEXT    NOT NULL,
  sampled_at          INTEGER NOT NULL,            -- epoch ms
  machine             TEXT    NOT NULL,
  five_hour_pct       INTEGER,
  seven_day_pct       INTEGER,
  five_hour_resets_at INTEGER,                     -- epoch s
  seven_day_resets_at INTEGER,                     -- epoch s
  auth_ok             INTEGER,
  exhausted_until     INTEGER,                     -- epoch s
  source              TEXT,
  synced              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, sampled_at, machine)
);

-- The dotfiles account picker's decisions, from picks.jsonl.
CREATE TABLE IF NOT EXISTS account_pick (
  ts       INTEGER NOT NULL,                       -- epoch ms
  lane     TEXT    NOT NULL,
  picked   TEXT    NOT NULL,
  reason   TEXT    NOT NULL,
  stale    INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT,                                   -- JSON: per-account {s,w} at pick time
  machine  TEXT    NOT NULL,
  synced   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, lane, machine)
);

-- IU's own cost report (the self-service portal), scraped from the MacBook. The
-- portal is the truth for the rolling 30-day cap; usage_record.cost_usd is our
-- estimate. One row per non-zero (day, label, row) cell, latest fetch wins
-- (today's value grows). model = our model_norm when the label matches one.
-- One report per IU API key (each key has its own cap); iu_key is part of the PK.
CREATE TABLE IF NOT EXISTS iu_portal_cost (
  iu_key     TEXT    NOT NULL DEFAULT 'personal',
  day        TEXT    NOT NULL,                      -- YYYY-MM-DD
  label      TEXT    NOT NULL,                      -- the portal's prettified model id
  row        INTEGER NOT NULL,                      -- heatmap row; two ids can share a label
  model      TEXT,
  cost_usd   REAL    NOT NULL,
  fetched_at INTEGER NOT NULL,                      -- epoch ms
  PRIMARY KEY (iu_key, day, label, row)
);

-- Monthly run of the same report: reconciliation anchor, not the cap.
CREATE TABLE IF NOT EXISTS iu_portal_total (
  iu_key     TEXT    NOT NULL DEFAULT 'personal',
  month      TEXT    NOT NULL,                      -- YYYY-MM
  total_usd  REAL    NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (iu_key, month)
);
`;
