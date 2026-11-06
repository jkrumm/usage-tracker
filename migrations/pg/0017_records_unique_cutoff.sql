-- records_unique starts at 2026-06-15: rows before it are kept in usage.records (never deleted), only hidden from every
-- reader of the view (Argo, stats, budget, the weekly report). The cutoff is the start of the period the tracker's numbers
-- can be trusted for. Revert it, or move it, with a later migration that replaces this view again.
-- window_attribution / window_intervals read usage.records directly and do not need it. Same columns as before.

CREATE OR REPLACE VIEW usage.records_unique AS
SELECT r.* FROM usage.records r
WHERE NOT EXISTS (SELECT 1 FROM usage.record_duplicates d WHERE d.record_id = r.id)
  AND r.ts >= '2026-06-15 00:00:00+00';
