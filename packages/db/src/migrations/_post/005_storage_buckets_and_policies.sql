-- Supabase Storage: the four buckets, and the RLS that makes direct browser
-- upload safe.
--
-- WHAT THIS REPLACES. Object storage was MinIO behind a tusd resumable-upload
-- sidecar. That whole arrangement is deleted, and not merely because it was
-- broken (it was: tusd wrote to a bucket `minio-init` never created, Caddy's
-- `handle_path /api/uploads/tus/*` did not match the create POST, and
-- TUSD_INTERNAL_URL was set nowhere so every branch returned 501). It is
-- deleted because MinIO WITHDREW their public Docker images -- the whole
-- `minio/*` namespace is gone from Docker Hub -- so the compose stack could not
-- start on any machine, regardless of every other defect. See
-- docs/verification.md (B9).
--
-- BUCKETS ARE ROWS. The Storage API has a createBucket call, but buckets are
-- backed by `storage.buckets`, so doing it here keeps bucket creation in the
-- same idempotent, ledgered lane as everything else rather than in a script
-- somebody has to remember to run.
--
-- PORTABILITY GUARD. Everything below is wrapped so that running the migration
-- against a plain Postgres -- a CI service container, a local dev database --
-- skips cleanly instead of aborting. Without this the whole migration run
-- fails at the first `storage.buckets` reference and no schema gets created at
-- all.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE '[_post/005] storage schema absent (not a Supabase database) -- skipping';
    RETURN;
  END IF;

  -- ── The four buckets, all PRIVATE ───────────────────────────────────────────
  --
  -- `public = false` is the load-bearing setting. A public bucket serves every
  -- object to anyone holding the URL, with no token and no expiry -- for a
  -- product whose objects are classroom recordings of identifiable children,
  -- that is the whole confidentiality model gone. Reads are signed, always.
  --
  -- file_size_limit is a SERVER-side cap. The client-side check in the upload
  -- component is a courtesy that tells the user early; this is the one an
  -- attacker cannot edit out of the DOM.
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES
    -- Source video as it arrives, from the browser or from WhatsApp. The mime
    -- list is deliberately broad: phone cameras and WhatsApp's own transcoder
    -- emit a wide spread, and TUS clients frequently send
    -- application/octet-stream because the browser could not determine a type.
    -- Narrowing this would reject legitimate teacher uploads in the field,
    -- which is a worse failure than accepting a file ffmpeg will reject.
    ('videos-original', 'videos-original', false, 2147483648,  -- 2 GiB
      ARRAY['video/mp4','video/quicktime','video/x-matroska','video/webm',
            'video/3gpp','video/x-msvideo','video/mpeg','application/octet-stream']),

    -- Transcoder output. Written only by the worker under the service role, so
    -- no RLS policy grants anyone else write access.
    ('videos-hls', 'videos-hls', false, 104857600,            -- 100 MiB/segment
      ARRAY['application/vnd.apple.mpegurl','application/x-mpegurl','video/mp2t']),

    ('posters', 'posters', false, 10485760,                   -- 10 MiB
      ARRAY['image/jpeg','image/png','image/webp']),

    -- Reading material. Admin-uploaded, tightly typed: this bucket is served to
    -- users through the media proxy, and an HTML file here would otherwise be a
    -- stored-XSS primitive on our own origin.
    ('pdfs', 'pdfs', false, 52428800,                         -- 50 MiB
      ARRAY['application/pdf'])
  ON CONFLICT (id) DO UPDATE
    SET public             = EXCLUDED.public,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

  -- ── RLS on storage.objects ─────────────────────────────────────────────────
  --
  -- Supabase enables RLS on storage.objects by default with no policies, so the
  -- starting position is "nobody but the service role can touch anything".
  -- Verified against this project: a user token attempting a resumable upload
  -- with no policy present gets
  --     403 new row violates row-level security policy
  --
  -- We add the minimum needed for the browser to upload its own video directly
  -- to Storage, and nothing else.

  -- Upload. The path MUST begin with the uploader's own uuid. This is what
  -- makes the object key unforgeable rather than merely unguessable: the same
  -- token attempting to write under another user's prefix is refused by the
  -- database, not by application code that could be bypassed.
  --
  -- Verified against this project:
  --   own prefix                  -> 201 Location issued
  --   another user's prefix       -> 403 new row violates row-level security policy
  DROP POLICY IF EXISTS "own uploads insert" ON storage.objects;
  CREATE POLICY "own uploads insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

  -- Resumable upload completion. A TUS transfer creates the row and then PATCHes
  -- it as chunks land, so INSERT alone gets a Location header and then stalls on
  -- the first chunk. Same ownership predicate, so this widens nothing.
  DROP POLICY IF EXISTS "own uploads update" ON storage.objects;
  CREATE POLICY "own uploads update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    )
    WITH CHECK (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

  -- Abandoning an in-progress upload. Scoped to the uploader's own prefix.
  -- Deliberately NOT extended to a completed submission: once a video is
  -- attached to an observation cycle it is programme evidence, and removing it
  -- is an administrative act with an audit row, not a DELETE the uploader can
  -- issue from a browser.
  DROP POLICY IF EXISTS "own uploads delete" ON storage.objects;
  CREATE POLICY "own uploads delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (
      bucket_id = 'videos-original'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

  -- ── NO SELECT POLICY. ANYWHERE. ────────────────────────────────────────────
  --
  -- This is a decision, not an omission.
  --
  -- Every read goes through a short-lived signed URL minted server-side, AFTER
  -- the application has checked that this user may see this particular video
  -- (lib/authz.ts assertCanAccessVideo). A SELECT policy on storage.objects
  -- could only express "the uploader may read their own file" -- it cannot
  -- express "the mentor assigned to this pairing", "the observer on this
  -- cycle", or "an admin", because those facts live in public.* tables that a
  -- storage policy has no business joining on every object read.
  --
  -- Adding a self-read policy would therefore not replace the authorization
  -- check; it would sit beside it as a second, weaker answer to the same
  -- question. Verified: a user token reading its own object directly with no
  -- SELECT policy gets a 4xx, which is the intended shape.
END
$$;
