-- Sessions and billable records (decisions U2, U4). Vocabulary and normalization rules: docs/usage-schema.md.

-- A session is an entity for every lane. Source-local id: the Claude/Codex/OpenCode session id, a Hermes
-- session id, an agw run id. parent_session_id links a worker/subagent to the session that spawned it.
CREATE TABLE usage.sessions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source             text        NOT NULL,
  source_session_id  text        NOT NULL,
  lane               text        NOT NULL CHECK (lane IN (
                       'interactive', 'wave_mother', 'lead', 'worker', 'fan_worker', 'subagent',
                       'hermes', 'iris', 'agw_workflow', 'other')),
  lane_detail        jsonb,                  -- {subagent_type, workflow, step, route, surface, raw}
  parent_session_id  bigint REFERENCES usage.sessions (id) DEFERRABLE INITIALLY DEFERRED,
  account            text,                   -- Max account id (billing = 'max' only)
  billing            text        NOT NULL DEFAULT 'unknown' CHECK (billing IN ('max', 'api_key', 'unknown')),
  api_key            text,                   -- IU key id (billing = 'api_key' only)
  machine            text,
  model              text,
  effort             text,
  repo               text,
  issue_id           text,
  run_id             text,
  first_ts           timestamptz,
  last_ts            timestamptz,
  UNIQUE (source, source_session_id)
);
CREATE INDEX sessions_parent_idx ON usage.sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;
CREATE INDEX sessions_issue_idx  ON usage.sessions (issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX sessions_repo_idx   ON usage.sessions (repo, first_ts);
CREATE INDEX sessions_lane_idx   ON usage.sessions (lane, first_ts);

-- One row per billable unit. The key is (source, source_id): machine is an attribute (the old
-- (source, source_id, machine) key duplicated $3,081 of spend). lane/lane_detail are the record's own
-- (a subagent request inside an interactive session is lane 'subagent' on the record).
CREATE TABLE usage.records (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source                text        NOT NULL,
  source_id             text        NOT NULL,
  grain                 text        NOT NULL CHECK (grain IN ('message', 'session')),
  ts                    timestamptz NOT NULL,
  session_id            bigint      REFERENCES usage.sessions (id),
  model_raw             text,
  model                 text,
  repo                  text,                -- directory under SourceRoot, 'iu/<dir>' under IuRoot, else NULL
  project_raw           text,                -- the collector's project string, verbatim
  workspace             text        CHECK (workspace IN ('work', 'private')),
  billing               text        NOT NULL DEFAULT 'unknown' CHECK (billing IN ('max', 'api_key', 'unknown')),
  account               text,
  api_key               text,
  machine               text,
  outcome               text        NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error')),
  lane                  text        NOT NULL DEFAULT 'other' CHECK (lane IN (
                          'interactive', 'wave_mother', 'lead', 'worker', 'fan_worker', 'subagent',
                          'hermes', 'iris', 'agw_workflow', 'other')),
  lane_detail           jsonb,
  effort                text,
  issue_id              text,
  run_id                text,
  input_tokens          bigint      NOT NULL DEFAULT 0,
  output_tokens         bigint      NOT NULL DEFAULT 0,
  cache_read_tokens     bigint      NOT NULL DEFAULT 0,
  cache_write_5m_tokens bigint      NOT NULL DEFAULT 0,
  cache_write_1h_tokens bigint      NOT NULL DEFAULT 0,
  reasoning_tokens      bigint      NOT NULL DEFAULT 0,   -- billed at the output rate, in addition to output_tokens
  duration_ms           integer,
  cost_reported_usd     numeric,             -- provider-reported, verbatim; NULL unless the provider stated one
  cost_usd              numeric,             -- final; NULL = unpriced
  cost_source           text        NOT NULL DEFAULT 'none' CHECK (cost_source IN ('reported', 'prices', 'override', 'none')),
  price_id              bigint      REFERENCES usage.prices (id),
  raw                   jsonb,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id),
  CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0
         AND cache_write_5m_tokens >= 0 AND cache_write_1h_tokens >= 0 AND reasoning_tokens >= 0)
);
CREATE INDEX records_ts_idx          ON usage.records (ts);
CREATE INDEX records_model_ts_idx    ON usage.records (model, ts);
CREATE INDEX records_session_idx     ON usage.records (session_id);
CREATE INDEX records_repo_idx        ON usage.records (repo);
CREATE INDEX records_account_ts_idx  ON usage.records (account, ts);
CREATE INDEX records_issue_idx       ON usage.records (issue_id) WHERE issue_id IS NOT NULL;
