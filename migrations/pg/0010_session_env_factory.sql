-- The factory runner's FACTORY_ROLE / FACTORY_SESSION per claude-code session id, from the same SessionStart hook line
-- as base_url / lane / account (dotfiles hooks/session-env.ts). Additive: NULL on every line written before the hook
-- logged them, and on every session the factory did not spawn.
ALTER TABLE usage.session_env
  ADD COLUMN factory_role    text,
  ADD COLUMN factory_session text;
