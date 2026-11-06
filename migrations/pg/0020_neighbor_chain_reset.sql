-- The first repair passes let a session resolved by `neighbor` count as evidence for the next one, so an attribution could
-- walk along a chain of sessions away from any direct proof. Resets the verdicts with no direct evidence in their own
-- 15-minute window; the repair pass resolves them again under the stricter rule, or leaves them without a repo.

CREATE TEMP TABLE chained ON COMMIT DROP AS
SELECT e.session_id, e.repo
FROM usage.session_repo e JOIN usage.sessions s ON s.id = e.session_id
WHERE e.evidence = 'neighbor'
  AND NOT EXISTS (
    SELECT 1 FROM usage.sessions d LEFT JOIN usage.session_repo de ON de.session_id = d.id
    WHERE d.source = 'claude-code'
      AND d.lane_detail->>'workflow' = s.lane_detail->>'workflow'
      AND abs(extract(epoch FROM d.first_ts - s.first_ts)) <= 900
      AND coalesce(d.repo, de.repo) IS NOT NULL
      AND de.evidence IS DISTINCT FROM 'neighbor');

-- The workspace was derived from the same verdict: clear it too, the repair pass derives it again.
UPDATE usage.records r
SET repo = NULL, ingested_at = now(),
    workspace = CASE WHEN r.workspace = (CASE WHEN c.repo LIKE 'iu/%' THEN 'work' ELSE 'private' END) THEN NULL ELSE r.workspace END
FROM chained c WHERE r.session_id = c.session_id AND r.repo = c.repo;

UPDATE usage.sessions s SET repo = NULL
FROM chained c WHERE s.id = c.session_id AND s.repo = c.repo;

DELETE FROM usage.session_repo e USING chained c WHERE e.session_id = c.session_id;
