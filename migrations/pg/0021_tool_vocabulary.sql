-- The canonical tool vocabulary. Argo's "Tool" dimension showed artifacts of the lane / lane_detail encoding
-- (review:angle:senior-dev, review_ocr, fan_worker, wave_mother, research-gateway:worker, final, r2). usage.tool_of maps a
-- record's (source, lane, lane_detail) to one short name; the view carries it as `tool`. lane_detail stays verbatim, so
-- every step, angle and role remains queryable. Rules: docs/usage-schema.md §Tool vocabulary.
--
-- A single CASE expression (LANGUAGE sql, IMMUTABLE) so the planner inlines it into the query.

CREATE FUNCTION usage.tool_of(source text, lane text, d jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lane
    WHEN 'interactive' THEN 'interactive'
    WHEN 'lead' THEN 'lead'
    WHEN 'wave_mother' THEN 'lead'
    WHEN 'worker' THEN CASE WHEN d->>'role' IN ('reviewer', 'deep') THEN d->>'role' ELSE 'worker' END
    WHEN 'fan_worker' THEN CASE WHEN d->>'role' IN ('reviewer', 'deep') THEN d->>'role' ELSE 'worker' END
    WHEN 'subagent' THEN CASE WHEN coalesce(d->>'subagent_type', '') IN ('', 'unknown') THEN 'subagent' ELSE d->>'subagent_type' END
    WHEN 'hermes' THEN 'hermes'
    WHEN 'iris' THEN 'iris'
    WHEN 'agw_workflow' THEN CASE
      WHEN coalesce(d->>'workflow', '') = '' THEN CASE
        WHEN coalesce(d->>'caller', '') IN ('', 'agw', 'agw-opencode') THEN 'agw' ELSE d->>'caller' END
      WHEN d->>'workflow' IN ('review', 'review_ocr', 'verify') THEN 'review'
      WHEN d->>'workflow' IN ('research', 'research-gateway') THEN 'research'
      WHEN d->>'workflow' = 'podcast' OR d->>'workflow' LIKE 'podcast.%' THEN 'podcast'
      WHEN source IN ('audio-gateway', 'audio-gateway-vps', 'audio-proxy')
        THEN CASE WHEN d->>'step' LIKE 'podcast-%' THEN 'podcast' ELSE 'audio' END
      WHEN d->>'workflow' IN ('door.speech', 'door.transcriptions') THEN 'audio'
      WHEN d->>'workflow' IN ('ab', 'ab-judge', 'bench') OR d->>'workflow' LIKE 'eval.%' OR d->>'workflow' LIKE 'cap.eval.%' THEN 'eval'
      WHEN d->>'workflow' IN ('narrative', 'narrative-polish', 'overview') THEN 'narrative'
      WHEN d->>'workflow' IN ('litellm', 'agent-gateway-opencode', 'unknown') THEN 'agw'
      ELSE split_part(d->>'workflow', '.', 1)
    END
    WHEN 'other' THEN CASE source
      WHEN 'athena-teamchat' THEN 'teamchat'
      WHEN 'claude-code' THEN 'headless'
      WHEN 'audio-gateway-mini' THEN 'audio'
      WHEN 'image-gen-gateway' THEN 'image'
      WHEN 'image-gateway' THEN 'image'
      ELSE source
    END
    ELSE lane
  END
$$;

-- Same columns and filters as 0017, `tool` appended last (CREATE OR REPLACE VIEW only allows appending). `r.*` expands
-- to the records columns at creation, so a later records column needs another replace, as it always did.
CREATE OR REPLACE VIEW usage.records_unique AS
SELECT r.*, usage.tool_of(r.source, r.lane, r.lane_detail) AS tool FROM usage.records r
WHERE NOT EXISTS (SELECT 1 FROM usage.record_duplicates d WHERE d.record_id = r.id)
  AND r.ts >= '2026-06-15 00:00:00+00';
