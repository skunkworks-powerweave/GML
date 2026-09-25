-- Close the PostgREST / Data API surface on every application table.
--
-- WHY. On a hosted Supabase project, PostgREST exposes the `public` schema and
-- Supabase grants SELECT (and more) to the `anon` and `authenticated` roles by
-- default. Our 47 tables were created by drizzle, which adds no RLS, so
-- immediately after the migrations ran this was true:
--
--     GET /rest/v1/users?select=*      -> 200
--     GET /rest/v1/learners?select=*   -> 200
--     GET /rest/v1/audit_log?select=*  -> 200
--     GET /rest/v1/section_gates       -> 200
--
-- ...using the anon key, which is PUBLIC BY DESIGN and ships in every browser
-- bundle. Verified against the live project while the tables were still empty.
-- With one teacher onboarded that is the full staff roster, every account email,
-- the entire audit trail, section-gate password hashes, and — via `learners` —
-- children's names, ages and guardian details, the exact table SM-9 exists to
-- protect.
--
-- The application never uses PostgREST. It talks to Postgres directly through
-- Drizzle. So this whole surface is attack surface with no upside.
--
-- TWO LAYERS, because either alone can be undone by a single dashboard click:
--   1. Revoke the table privileges the API roles were granted by default.
--   2. Enable RLS with NO permissive policies, so even a re-granted role reads
--      nothing.
--
-- ONLY FOR THE TABLES THAT EXISTED WHEN THIS RAN. This file is ledgered, so it
-- never runs again, and tables from later migrations (0024 jobs/rate_limits,
-- 0026 quiz_attempts, ...) were left with RLS off on every database it had
-- already run on. _post/always/001_rls_on_every_table.sql now re-applies both
-- layers on every deploy; this file is kept as the record of the first run.
--
-- This costs the application nothing: it connects as the table OWNER, and an
-- owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set (it is not). When
-- per-user RLS is introduced later it will need a dedicated non-owner role —
-- see the plan's §2.6 for why that is a separate, larger piece of work.
--
-- ALSO DO THIS IN THE DASHBOARD: Settings -> API -> Exposed schemas -> remove
-- `public`. That switches the surface off at the gateway. The SQL below is what
-- keeps it shut if anyone ever switches it back on.

-- PORTABILITY. `anon` and `authenticated` are Supabase roles. On a plain
-- Postgres -- a CI service container, a local dev database -- they do not
-- exist, and an unguarded REVOKE aborts the whole migration run, so NO schema
-- gets created at all. The role checks below make this file a no-op there
-- while still doing its full job on Supabase.
--
-- RLS enablement is deliberately OUTSIDE the role guard: it is portable, it
-- costs nothing, and it means a non-Supabase database ends up in the same
-- nothing-readable-by-non-owners posture rather than a weaker one.

-- ── 1. Application tables ─────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  has_api_roles boolean;
BEGIN
  SELECT count(*) = 2 INTO has_api_roles
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated');

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  LOOP
    -- Drop the default API grants. service_role is deliberately left alone: it
    -- is the server-side admin identity, already bypasses RLS, and is never
    -- exposed to a browser.
    IF has_api_roles THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.relname);
    END IF;

    -- Defence in depth. No policies are created, so the effective grant for any
    -- non-owner role is "nothing".
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  IF NOT has_api_roles THEN
    RAISE NOTICE '[_post/002] anon/authenticated absent (not a Supabase database) -- RLS enabled, grants skipped';
    RETURN;
  END IF;

  -- Stop future tables from inheriting the same default grants.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

  -- INERT, AND KEPT ONLY AS HISTORY. This was meant to stop a hand-restored
  -- table grant from being usable at all. It cannot: anon and authenticated
  -- hold USAGE on `public` through PUBLIC (`=U/pg_database_owner`), which
  -- revoking from the two roles by name does not touch, so
  -- has_schema_privilege('anon', 'public', 'USAGE') is still true. Revoking it
  -- from PUBLIC is not safe either: Supabase's own service roles (storage
  -- among them) reach `public` the same way, as does any function a Storage
  -- RLS policy calls there. The barriers are the table grants and RLS -- see
  -- _post/always/001.
  REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
END
$$;--> statement-breakpoint

-- ── 2. SM-1: audit_log stays append-only on Supabase too ──────────────────────
-- _post/001 revokes UPDATE/DELETE/TRUNCATE from PUBLIC and from the role named
-- in `app.runtime_user` (or a role literally called `gml`). Neither exists on a
-- hosted Supabase project, so that half of SM-1 silently did nothing here —
-- only the BEFORE UPDATE / BEFORE DELETE triggers carried it. Supabase grants
-- these three roles explicitly, and an explicit grant is not removed by
-- revoking from PUBLIC, so they need naming.
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NOT NULL
     AND (SELECT count(*) = 3 FROM pg_roles
           WHERE rolname IN ('anon', 'authenticated', 'service_role')) THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_log FROM anon, authenticated, service_role';
  END IF;
  -- On a non-Supabase database these roles do not exist, and SM-1 rests
  -- entirely on _post/001's BEFORE UPDATE / BEFORE DELETE triggers -- which are
  -- portable and are the load-bearing control either way.
END
$$;
