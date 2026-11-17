-- Tool calls per session (docs/usage-schema.md §Session events). A tool call is a `tool` event of usage.session_events:
-- one row per `tool_use` block of a transcript, event_id `tool:<tool_use id>` (the prefix keeps it apart from the `skill`
-- event of a Skill call, which uses the bare id), `name` = the tool's name, never its input. A subagent's calls belong to
-- its own session (`<session>:<agent>`), as for the other kinds. History is filled by `make backfill-events`.
--
-- session_signals gets `tool_calls` as its last column (CREATE OR REPLACE VIEW appends only, so the existing columns and
-- the grants of the view are untouched). The software-factory's `factory` role reads the view (it already reads
-- `sessions` and `records_unique`, 0022): the view runs with its owner's rights, so session_events stays closed.
-- Guarded on the role, like 0022: a server without `factory` still migrates. GRANT is idempotent.

ALTER TABLE usage.session_events DROP CONSTRAINT session_events_kind_check;
ALTER TABLE usage.session_events
  ADD CONSTRAINT session_events_kind_check CHECK (kind IN ('compaction', 'skill', 'tool'));

CREATE OR REPLACE VIEW usage.session_signals AS
SELECT s.id AS session_id, s.source, s.source_session_id, s.lane, s.account, s.repo, s.issue_id, s.effort,
       s.parent_session_id, s.first_ts, s.last_ts,
       r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
       r.cache_read_tokens::float8
         / nullif(r.input_tokens + r.cache_read_tokens + r.cache_write_5m_tokens + r.cache_write_1h_tokens, 0) AS cache_hit_ratio,
       e.compactions, e.skill_calls, e.skill_chars, e.tool_calls
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
         coalesce(sum(size_chars) FILTER (WHERE kind = 'skill'), 0)::bigint AS skill_chars,
         count(*) FILTER (WHERE kind = 'tool')::int AS tool_calls
  FROM usage.session_events WHERE source = s.source AND source_session_id = s.source_session_id
) e;

-- lane_signals aggregates its events by lane and day: tool events (by far the most numerous) are not its business, so
-- they are left out of the scan; its columns and results are unchanged.
CREATE OR REPLACE VIEW usage.lane_signals AS
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
  WHERE e.kind IN ('compaction', 'skill')
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory') THEN
    GRANT USAGE ON SCHEMA usage TO factory;
    GRANT SELECT ON usage.session_signals TO factory;
  ELSE
    RAISE NOTICE 'role factory does not exist: 0024 granted nothing; create the role first, then add a migration repeating this grant';
  END IF;
END
$$;
