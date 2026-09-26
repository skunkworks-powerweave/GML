-- The upload-reservation check moves out of the schema the Data API exposes.
--
-- WHY. _post/008 put public.storage_upload_is_reserved -- SECURITY DEFINER,
-- EXECUTE granted to `authenticated` -- in `public`, the schema PostgREST
-- serves by default. It is the one owner-privileged function there that a
-- signed-in token may call. The live project no longer exposes `public`
-- (docs/verification.md), but _post/002 holds that the SQL layer has to stand
-- on its own if one dashboard click re-exposes it, and then this function is
-- callable as /rest/v1/rpc/storage_upload_is_reserved by any signed-in user.
-- What it answers is only a boolean about the caller's own reservation, so
-- nothing leaks today; it is still the shape Supabase's security advisor flags
-- and the kind of surface a hand-restored grant on `public` widens.
--
-- WHAT THIS DOES. The same function, in a schema of its own that no API role
-- but `authenticated` can even resolve names in, and that is never added to
-- the exposed schemas. The storage INSERT policy is re-created to call it
-- there, and the copy in `public` is dropped (after the policy, which depends
-- on it). storage-api still evaluates the policy as `authenticated`, which is
-- why that role keeps USAGE on the schema and EXECUTE on the function.
--
-- AND ONE CORRECTION. 008's comment said a non-integer contentLength "can
-- only fail the comparison, never raise"; `"abc"` raised invalid input syntax
-- for type numeric. storage-api always sends a number, so only a direct caller
-- could hit it, but the cast is now guarded so the comment is true: anything
-- but a JSON number is NULL, and NULL admits nothing.
--
-- 008 is left as it was: _post files are ledgered by filename, so a database
-- that has applied it would never see an edit.
--
-- PORTABILITY. The same guard as 008: skipped where the storage/auth schemas
-- or Supabase's roles are absent.

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) < 2 THEN
    RAISE NOTICE '[_post/013] storage/auth schema or API roles absent (not a Supabase database) -- skipping';
    RETURN;
  END IF;

  CREATE SCHEMA IF NOT EXISTS private;
  REVOKE ALL ON SCHEMA private FROM PUBLIC;
  GRANT USAGE ON SCHEMA private TO authenticated;

  CREATE OR REPLACE FUNCTION private.storage_upload_is_reserved(p_bucket text, p_name text, p_metadata jsonb)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
  AS $fn$
    SELECT EXISTS (
      SELECT 1
      FROM public.files f
      WHERE f.bucket = p_bucket
        AND f.object_key = p_name
        AND f.kind = 'video_original'
        AND f.status IN ('uploading', 'failed')
        AND f.owner_user_id = (SELECT auth.uid())
        AND f.size_bytes IS NOT NULL
        -- numeric, not bigint, and only from a JSON number: anything else is
        -- NULL, which fails the comparison and never raises. A missing size
        -- is NULL too, and NULL admits nothing.
        AND CASE WHEN jsonb_typeof(p_metadata -> 'contentLength') = 'number'
                 THEN (p_metadata ->> 'contentLength')::numeric END <= f.size_bytes
    )
  $fn$;

  REVOKE ALL ON FUNCTION private.storage_upload_is_reserved(text, text, jsonb) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION private.storage_upload_is_reserved(text, text, jsonb) TO authenticated;

  DROP POLICY IF EXISTS "own uploads insert" ON storage.objects;
  CREATE POLICY "own uploads insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND private.storage_upload_is_reserved(bucket_id, name, metadata)
    );

  DROP FUNCTION IF EXISTS public.storage_upload_is_reserved(text, text, jsonb);
END
$$;
