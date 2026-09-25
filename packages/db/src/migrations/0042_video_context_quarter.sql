-- Numbered 0042 at merge: written as 0039 on the wave-2 branch while 0039-0041
-- landed here, and drizzle's migrator skips an entry older than the newest
-- one applied, so it had to come after 0041. Idempotent, so a database that
-- ran it under the old number takes it again harmlessly.
--
-- Which quarter a mentee's quarterly video is for.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--
-- The Mentorship surface is meeting recordings plus a mentee's Q1 (baseline)
-- and Q4 (endline) videos. A quarterly video is a video_submissions row with
-- context_type 'mentee_quarterly' and context_id = the pairing, and nothing
-- recorded WHICH quarter it was for: a Q1 and a Q4 video of the same pairing
-- were indistinguishable, and the pairing page could not show them apart.
--
-- The quarter is chosen by the uploader when the upload is reserved, so it has
-- to live on the submission itself -- the completion call and the reconciler
-- that can finish an upload whose completion never arrived both work from the
-- row alone.
--
-- Nullable, and only ever set for 'mentee_quarterly', to 1 or 4
-- (video_submissions_context_quarter_check). Every existing row, and every
-- other context, carries NULL.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- ALTER TABLE "video_submissions" DROP CONSTRAINT IF EXISTS "video_submissions_context_quarter_check";
-- ALTER TABLE "video_submissions" DROP COLUMN IF EXISTS "context_quarter";

ALTER TABLE "video_submissions" ADD COLUMN IF NOT EXISTS "context_quarter" smallint;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "video_submissions"
    ADD CONSTRAINT "video_submissions_context_quarter_check"
    CHECK ("context_quarter" IS NULL OR ("context_type" = 'mentee_quarterly' AND "context_quarter" IN (1, 4)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
