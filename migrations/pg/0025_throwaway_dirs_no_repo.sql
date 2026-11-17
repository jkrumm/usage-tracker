-- A numbered throwaway directory under SourceRoot (`scratch-1636`) is no repo: normalizeRepo (src/repo.ts) now returns NULL
-- for it, but `repair` never overwrites a stored repo with NULL, so the rows written before that rule keep the dead name
-- and `make verify` fails on "unknown repo". `project_raw` stays verbatim. Idempotent; a later such name is NULL from the start.
UPDATE usage.records SET repo = NULL WHERE repo ~ '^scratch-[0-9]+$';
UPDATE usage.sessions SET repo = NULL WHERE repo ~ '^scratch-[0-9]+$';
