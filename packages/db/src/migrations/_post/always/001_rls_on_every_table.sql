-- Keep the Data API shut on EVERY public table, including ones created after
-- _post/002 first ran. Runs on every deploy (scripts/migrate.ts, the
-- `_post/always` lane), so it must stay idempotent and cheap.
--
-- WHY THIS IS NOT IN _post/002. 002 loops over the tables that exist at the
-- moment it runs, and migrate.ts ledgers it by filename, so it never runs
-- again. On a database where it had been applied, every table created by a
-- later numbered migration kept RLS off and kept whatever grants the API roles
-- were handed. The live project took 002 before 0024 (jobs, rate_limits) and
-- 0026 (quiz_attempts), so those three and every future table were one
-- re-granted privilege away from being readable with the anon key, which ships
-- in every browser bundle. A fresh database never showed it: there 002 runs
-- after every numbered migration.
--
-- CHEAP BY CONSTRUCTION. ALTER TABLE ... ENABLE ROW LEVEL SECURITY takes an
-- ACCESS EXCLUSIVE lock, and a deploy runs while the previous app is still
-- serving. So a table is only touched when it actually needs it: RLS off, or
-- an API role holding a privilege. Once converged, a run changes nothing and
-- locks nothing.
--
-- The same two layers as 002, and the same portability: RLS is enabled
-- everywhere; the grant revoke only where Supabase's `anon` / `authenticated`
-- exist. No policies are created, so the effective access for any non-owner
-- role is nothing. The app connects as the owner, which RLS does not bind
-- (FORCE is not set).
DO $$
DECLARE
  r record;
  has_api_roles boolean;
BEGIN
  SELECT count(*) = 2 INTO has_api_roles
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated');

  FOR r IN
    SELECT c.oid, c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    IF NOT r.relrowsecurity THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
      RAISE NOTICE '[_post/always/001] enabled RLS on public.%', r.relname;
    END IF;

    IF has_api_roles AND (
         has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_table_privilege('authenticated', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.relname);
      RAISE NOTICE '[_post/always/001] revoked API-role grants on public.%', r.relname;
    END IF;
  END LOOP;
END
$$;
