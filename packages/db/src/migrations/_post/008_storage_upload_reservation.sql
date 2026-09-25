-- Storage admits a direct upload only into a key the server reserved for it.
--
-- WHY. _post/005's INSERT policy on storage.objects checked the bucket and that
-- the key began with the caller's own uuid, and nothing else. So any signed-in
-- teacher, mentor or observer token could POST as many objects as it liked
-- under its own prefix -- any name, any listed mime type, each up to the
-- bucket's 2 GiB cap -- ignoring the programme's videoMaxUploadMb (500 MB by
-- default) and the files registry. Nothing reconciles an object that has no
-- files row, and backup.sh copies every one into the DR bucket and never
-- deletes it. Verified against the local stack: a teacher token POSTing an
-- unreserved key under its own prefix got 200.
--
-- WHAT A RESERVATION IS. beginUpload (apps/web/src/lib/video/upload.ts) writes
-- a public.files row before any bytes move: bucket 'videos-original', the
-- object key it issued, kind 'video_original', status 'uploading', the size
-- the browser declared (already checked against videoMaxUploadMb) and the
-- uploader as owner. The policy now requires that row, for this caller, at a
-- declared size no larger than the one reserved.
--
-- HOW STORAGE CHECKS. storage-api authorises every upload request -- the TUS
-- create, every PATCH, and a plain POST -- by running this INSERT as
-- `authenticated`, with the caller's token claims set, inside a transaction it
-- rolls back (Uploader.canUpload). The row carries metadata.contentLength: the
-- TUS Upload-Length, i.e. the whole file's size, or a POST's Content-Length.
-- The object row it finally keeps is written afterwards as the superuser. So
-- this policy is the check, once per request, and tus-js-client (which sends
-- Upload-Length = file.size, the same number beginUpload reserved) passes it.
--
-- WHY 'failed' IS ADMITTED TOO. The reconciler marks a reservation failed
-- after UPLOAD_ABANDON_AFTER_HOURS with no bytes, and completeUpload revives
-- exactly that reservation when a slow upload lands afterwards. Refusing the
-- late PATCH would lose a teacher's upload that the rest of the system is
-- built to accept. Either way it is one object per reservation: the key is
-- unique, and with no SELECT policy an existing object cannot be overwritten.
--
-- WHY A SECURITY DEFINER FUNCTION. `authenticated` has no grant on
-- public.files and RLS on it (_post/002), and must keep it that way, so the
-- policy cannot read the table itself. The function runs as its owner (the
-- migrate role, which owns public.files), with an empty search_path so nothing
-- it names can be shadowed, and only reports a boolean about the CALLER's own
-- reservation: auth.uid() is read inside, never taken as an argument.
--
-- The UPDATE policy is left as _post/005 wrote it. An UPDATE needs SELECT
-- visibility to find its row, and there is deliberately no SELECT policy, so
-- `authenticated` cannot update an object at all.
--
-- PORTABILITY. Skipped where the storage/auth schemas or Supabase's roles are
-- absent, like _post/005.

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) < 2 THEN
    RAISE NOTICE '[_post/008] storage/auth schema or API roles absent (not a Supabase database) -- skipping';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.storage_upload_is_reserved(p_bucket text, p_name text, p_metadata jsonb)
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
        -- numeric, not bigint: a non-integer can only fail the comparison,
        -- never raise. A missing size is NULL, and NULL admits nothing.
        AND (p_metadata ->> 'contentLength')::numeric <= f.size_bytes
    )
  $fn$;

  REVOKE ALL ON FUNCTION public.storage_upload_is_reserved(text, text, jsonb) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.storage_upload_is_reserved(text, text, jsonb) TO authenticated;

  DROP POLICY IF EXISTS "own uploads insert" ON storage.objects;
  CREATE POLICY "own uploads insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND public.storage_upload_is_reserved(bucket_id, name, metadata)
    );
END
$$;
