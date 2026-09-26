-- Supabase Storage: the private bucket SCORM package files live in (F41).
--
-- One object per validated file, under `<package id>/<n>`, written by the
-- application's service role during an administrator's upload
-- (apps/web/src/lib/scorm/ingest.ts) and read back only by the content route
-- (/api/scorm/content/...), after it has checked the viewer may launch that
-- package. Same portability guard as _post/005: a plain Postgres with no
-- storage schema skips cleanly.
--
--   public = false          reads are proxied by the application, never a
--                           public URL: the route is what decides who may
--                           launch a package, and it is also what attaches
--                           the content CSP a package's inline scripts need.
--   file_size_limit 50 MiB  SCORM_LIMITS.maxEntryBytes (lib/scorm/package.ts)
--                           -- the server-side cap behind the upload check.
--   application/octet-     every object is stored as opaque bytes. The type a
--   stream only             file is SERVED with comes from the extension
--                           allowlist in lib/scorm/files.ts, so a signed URL
--                           to this bucket, should one ever leak, renders no
--                           HTML on Supabase's origin, and there is a single
--                           answer to "what can run as what".
--
-- NO POLICIES. Nothing but the service role reads or writes these objects,
-- which is the default with RLS on and no policy (_post/005 explains why
-- reads are never granted by a policy).

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE '[_post/009] storage schema absent (not a Supabase database) -- skipping';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES
    ('scorm-packages', 'scorm-packages', false, 52428800,       -- 50 MiB
      ARRAY['application/octet-stream'])
  ON CONFLICT (id) DO UPDATE
    SET public             = EXCLUDED.public,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
END
$$;
