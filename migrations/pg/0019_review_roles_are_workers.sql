-- Factory sessions with role `reviewer` or `deep` fell through laneForRole to the runner's USAGE_LANE (`wave`), so they were
-- filed under wave_mother. They are workers; lane_detail.role keeps the distinction. Attribution only, no cost column moves.

UPDATE usage.sessions SET lane = 'worker'
WHERE lane = 'wave_mother' AND lane_detail->>'role' IN ('reviewer', 'deep');

UPDATE usage.records SET lane = 'worker', ingested_at = now()
WHERE lane = 'wave_mother' AND lane_detail->>'role' IN ('reviewer', 'deep');
