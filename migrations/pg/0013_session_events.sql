-- Session events (Wave 3, docs/usage-schema.md §Session events): compactions and skill loads of a session, plus the
-- cost signals derived from them and from the token sums. Additive: one table, two views.
--
-- An event is not a record attribute: a compaction boundary line carries no usage, a record's `raw` is overwritten by the
-- last line of its request, and a skill's size arrives on a different transcript line than its call (the two halves
-- merge here, by event id). event_id = the boundary line's uuid / the Skill tool_use id. No FK to sessions: an event can
-- be written before its session's first record; the views join on (source, source_session_id).
CREATE TABLE usage.session_events (
  source             text        NOT NULL,
  event_id           text        NOT NULL,
  source_session_id  text        NOT NULL,   -- same key as sessions.source_session_id (`<session>:<agent>` for a subagent)
  kind               text        NOT NULL CHECK (kind IN ('compaction', 'skill')),
  ts                 timestamptz NOT NULL,
  name               text,                   -- skill: the skill's name
  size_chars         integer,                -- skill: characters of the injected skill text; NULL = not seen
  detail             jsonb,                  -- compaction: {trigger, preTokens, postTokens, durationMs}
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);
CREATE INDEX session_events_session_idx ON usage.session_events (source, source_session_id);
CREATE INDEX session_events_kind_ts_idx ON usage.session_events (kind, ts);

-- session_signals: one row per session. Token sums from its records (usage.records_unique: the marked gateway-mirror
-- copies would count the same call twice), the cache hit ratio
--   cache_read / (input + cache_read + cache_write_5m + cache_write_1h)    NULL when the denominator is 0,
-- and the counts of its events (0, never NULL, when none). LATERAL subselects per session, so a filter on sessions
-- (e.g. last_ts) is applied before records and events are touched (records_session_idx, session_events_session_idx).
CREATE VIEW usage.session_signals AS
SELECT s.id AS session_id, s.source, s.source_session_id, s.lane, s.account, s.repo, s.issue_id, s.effort,
       s.parent_session_id, s.first_ts, s.last_ts,
       r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
       r.cache_read_tokens::float8
         / nullif(r.input_tokens + r.cache_read_tokens + r.cache_write_5m_tokens + r.cache_write_1h_tokens, 0) AS cache_hit_ratio,
       e.compactions, e.skill_calls, e.skill_chars
FROM usage.sessions s
CROSS JOIN LATERAL (
  SELECT coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
         coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
         coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
         coalesce(sum(cache_write_5m_tokens), 0)::bigint AS cache_write_5m_tokens,
         coalesce(sum(cache_write_1h_tokens), 0)::bigint AS cache_write_1h_tokens
  FROM usage.records_unique WHERE session_id = s.id
) r
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE kind = 'compaction')::int AS compactions,
         count(*) FILTER (WHERE kind = 'skill')::int AS skill_calls,
         coalesce(sum(size_chars) FILTER (WHERE kind = 'skill'), 0)::bigint AS skill_chars
  FROM usage.session_events WHERE source = s.source AND source_session_id = s.source_session_id
) e;

-- lane_signals: grain (source, lane, day UTC). Token sums and the cache hit ratio from the RECORDS by the record's own lane
-- (a subagent request inside an interactive session counts for `subagent`); the ratio is recomputed from the sums, never an
-- average of ratios. Events count for the lane of their session (an event whose session has no row yet is not listed).
-- Full join: a lane/day with only events still appears, with zero tokens and a NULL ratio.
CREATE VIEW usage.lane_signals AS
WITH rec AS (
  SELECT source, lane, (ts AT TIME ZONE 'UTC')::date AS day,
         sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
         sum(cache_read_tokens)::bigint AS cache_read_tokens,
         sum(cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
         sum(cache_write_1h_tokens)::bigint AS cache_write_1h_tokens
  FROM usage.records_unique
  GROUP BY 1, 2, 3
),
ev AS (
  SELECT e.source, s.lane, (e.ts AT TIME ZONE 'UTC')::date AS day,
         count(*) FILTER (WHERE e.kind = 'compaction')::int AS compactions,
         count(*) FILTER (WHERE e.kind = 'skill')::int AS skill_calls,
         coalesce(sum(e.size_chars) FILTER (WHERE e.kind = 'skill'), 0)::bigint AS skill_chars
  FROM usage.session_events e
  JOIN usage.sessions s ON s.source = e.source AND s.source_session_id = e.source_session_id
  GROUP BY 1, 2, 3
)
SELECT coalesce(rec.source, ev.source) AS source, coalesce(rec.lane, ev.lane) AS lane, coalesce(rec.day, ev.day) AS day,
       coalesce(rec.input_tokens, 0) AS input_tokens, coalesce(rec.output_tokens, 0) AS output_tokens,
       coalesce(rec.cache_read_tokens, 0) AS cache_read_tokens,
       coalesce(rec.cache_write_5m_tokens, 0) AS cache_write_5m_tokens,
       coalesce(rec.cache_write_1h_tokens, 0) AS cache_write_1h_tokens,
       rec.cache_read_tokens::float8
         / nullif(rec.input_tokens + rec.cache_read_tokens + rec.cache_write_5m_tokens + rec.cache_write_1h_tokens, 0) AS cache_hit_ratio,
       coalesce(ev.compactions, 0) AS compactions, coalesce(ev.skill_calls, 0) AS skill_calls,
       coalesce(ev.skill_chars, 0) AS skill_chars
FROM rec
FULL JOIN ev ON ev.source = rec.source AND ev.lane = rec.lane AND ev.day = rec.day;
