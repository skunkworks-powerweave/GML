-- Re-assert every privilege the ledgered _post files set. Runs on every
-- deploy (scripts/migrate.ts, the `_post/always` lane), so it must stay
-- idempotent and cheap: GRANT and REVOKE of what is already held or absent
-- change nothing.
--
-- WHY. backup.sh dumps with --no-acl and the DR runbook restores with
-- --no-acl, so a restored database has none of these privileges -- and its
-- restored _post_migrations_applied ledger says the files that made them have
-- run, so migrate never ran them again. GoTrue lost EXECUTE on the access-token
-- hook (nobody could sign in), and `authenticated` lost the private schema the
-- Storage INSERT policy calls (every browser upload refused). The objects
-- themselves (functions, policies, triggers) survive a --no-acl restore; only
-- the grants do not, and those are what this file puts back.
--
-- The same portability as the files it mirrors: each block runs only where
-- its object and roles exist, so a plain Postgres (CI, the restore drill) is
-- left as it is. Sources: _post/001, 002, 003, 004, 013.

-- SM-1 (_post/001, 002): audit_log is append-only for everyone but its owner.
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RETURN;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_log FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gml') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_log FROM gml;
  END IF;
END
$$;--> statement-breakpoint

-- Data API (_post/002): tables created later inherit nothing for the API roles.
-- The per-table revoke and RLS are _post/always/001.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) < 2 THEN
    RETURN;
  END IF;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
END
$$;--> statement-breakpoint

-- Identity triggers (_post/003): nobody calls them directly.
DO $$
BEGIN
  IF to_regprocedure('public.handle_new_auth_user()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
  END IF;
  IF to_regprocedure('public.sync_auth_user_email()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.sync_auth_user_email() FROM PUBLIC;
  END IF;
END
$$;--> statement-breakpoint

-- The access-token hook (_post/004): GoTrue alone may call it.
DO $$
BEGIN
  IF to_regprocedure('public.custom_access_token_hook(jsonb)') IS NULL THEN
    RETURN;
  END IF;
  REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) = 2 THEN
    REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
  END IF;
END
$$;--> statement-breakpoint

-- The upload reservation check (_post/013): the Storage INSERT policy calls it
-- as `authenticated`.
DO $$
BEGIN
  IF to_regnamespace('private') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;
  REVOKE ALL ON SCHEMA private FROM PUBLIC;
  GRANT USAGE ON SCHEMA private TO authenticated;
  IF to_regprocedure('private.storage_upload_is_reserved(text, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION private.storage_upload_is_reserved(text, text, jsonb) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON FUNCTION private.storage_upload_is_reserved(text, text, jsonb) FROM anon;
    END IF;
    GRANT EXECUTE ON FUNCTION private.storage_upload_is_reserved(text, text, jsonb) TO authenticated;
  END IF;
END
$$;
