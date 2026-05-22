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
  billing            TEXT    NOT NULL,            -- 'max' (sunk) | 'iu' (per-token) | …
  machine            TEXT,                        -- host that produced the record (derived at ingest)
  outcome            TEXT    NOT NULL DEFAULT 'ok', -- 'ok' | 'error' (bridge request outcome)

  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,

  cost_usd           REAL,                         -- computed from pricing.ts; NULL if model unpriced
  cost_source        TEXT    NOT NULL DEFAULT 'none', -- 'computed' | 'none'

  raw                TEXT,                         -- JSON: source-specific extras
  ingested_at        TEXT    NOT NULL,
  synced_at          TEXT,                         -- set by the Argo remote sync client; NULL = not yet pushed

  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_record (ts);
CREATE INDEX IF NOT EXISTS idx_usage_source  ON usage_record (source);
CREATE INDEX IF NOT EXISTS idx_usage_model   ON usage_record (model_norm);
CREATE INDEX IF NOT EXISTS idx_usage_billing ON usage_record (billing);

-- One row per collector: its watermark and last-run bookkeeping.
CREATE TABLE IF NOT EXISTS collector_state (
  source         TEXT PRIMARY KEY,
  cursor         TEXT,
  last_run_at    TEXT,
  last_status    TEXT,             -- 'ok' | 'skipped' | 'error'
  last_note      TEXT,
  records_total  INTEGER NOT NULL DEFAULT 0
);
`;
