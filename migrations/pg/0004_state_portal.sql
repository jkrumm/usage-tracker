-- Collector bookkeeping, the hook's per-session environment and IU's portal cost report (Wave 2 step 1).
-- Mirrors the SQLite tables of the same names (src/schema.ts) with real types.

-- One row per collector: its watermark and last-run bookkeeping.
CREATE TABLE usage.collector_state (
  source         text        PRIMARY KEY,
  cursor         text,
  last_run_at    timestamptz,
  last_status    text,                       -- 'ok' | 'skipped' | 'error'
  last_note      text,
  records_total  bigint      NOT NULL DEFAULT 0
);

-- claude-code session_env lines (base_url + USAGE_LANE + account per session id), persisted because the hook's log
-- files are pruned after 3 days while herdr sessions run for longer. The writer reads it to classify billing and
-- the Max account of a batch's sessions.
CREATE TABLE usage.session_env (
  session   text        PRIMARY KEY,
  base_url  text,
  lane      text,
  account   text,                            -- Claude Max account id from the hook; NULL on pre-account lines
  seen_at   timestamptz NOT NULL
);

-- IU's own cost report (the self-service portal), scraped from the MacBook. The portal is the truth for the rolling
-- 30-day cap; records.cost_usd is our estimate. One row per non-zero (day, label, row) cell, latest fetch wins.
-- One report per IU API key (each key has its own cap); iu_key is part of the key.
CREATE TABLE usage.iu_portal_cost (
  iu_key      text        NOT NULL DEFAULT 'personal',
  day         date        NOT NULL,
  label       text        NOT NULL,          -- the portal's prettified model id
  "row"       integer     NOT NULL,          -- heatmap row; two ids can share a label
  model       text,                          -- our normalized model when the label matches one
  cost_usd    numeric     NOT NULL,
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (iu_key, day, label, "row")
);

-- Monthly run of the same report: reconciliation anchor, not the cap.
CREATE TABLE usage.iu_portal_total (
  iu_key      text        NOT NULL DEFAULT 'personal',
  month       text        NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- YYYY-MM
  total_usd   numeric     NOT NULL,
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (iu_key, month)
);
