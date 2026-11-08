-- Read access for the software-factory's `factory` role. The factory's /v1/kpis joins exactly these three relations
-- (cost per session, the unique record view, the window share) and writes nothing. USAGE on the schema plus SELECT
-- on the three relations; no default privileges, so a new relation stays invisible to it until a migration says
-- otherwise. The views run with their owner's rights (no security_invoker), so the underlying tables stay closed.
--
-- Guarded on the role: a server without `factory` (a test cluster, a fresh host) still migrates. GRANT is idempotent.
-- A migration that DROPs and recreates one of these relations loses the grant and must repeat it
-- (CREATE OR REPLACE VIEW keeps it). Reader list: docs/usage-schema.md.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory') THEN
    GRANT USAGE ON SCHEMA usage TO factory;
    GRANT SELECT ON usage.sessions, usage.records_unique, usage.session_window_share TO factory;
  ELSE
    RAISE NOTICE 'role factory does not exist: 0022 granted nothing; create the role first, then add a migration repeating this grant';
  END IF;
END
$$;
