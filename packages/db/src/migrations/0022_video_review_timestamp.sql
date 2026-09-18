-- Separate REVIEW state from PIPELINE state on video_submissions.
--
-- Two bugs, one cause. `video_status` is a single mutually-exclusive enum that
-- was carrying both "where is this in the transcode pipeline" and "has a mentor
-- reviewed it":
--
--   1. POST /api/teach-back/[id]/review set status='reviewed'. The player only
--      builds a source when status='ready', so marking a teach-back reviewed
--      permanently destroyed playback, with no UI path back. The review page's
--      own "View video" link then landed on a dead player.
--
--   2. Nothing in the codebase ever WROTE 'review_pending' -- the worker writes
--      ready/failed and the WhatsApp webhook writes received. So the teach-back
--      "Pending review" filter and the sidebar review badge counted rows that
--      could not exist, and always showed zero.
--
-- Modelling review as its own nullable timestamp fixes both: status stays
-- 'ready' so the video keeps playing, and "pending review" becomes a real,
-- derivable predicate (ready AND reviewed_at IS NULL).

ALTER TABLE "video_submissions" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_submissions" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "video_submissions"
    ADD CONSTRAINT "video_submissions_reviewed_by_user_id_users_id_fk"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Partial index: the teach-back queue asks "which ready teach-backs are still
-- unreviewed", so only unreviewed rows need to be in the index.
CREATE INDEX IF NOT EXISTS "video_submissions_pending_review_idx"
  ON "video_submissions" ("context_type", "created_at")
  WHERE "reviewed_at" IS NULL;--> statement-breakpoint

-- Carry across any rows already wedged in the terminal 'reviewed' state so they
-- become playable again instead of staying stuck.
UPDATE "video_submissions"
   SET "reviewed_at" = COALESCE("reviewed_at", now()),
       "status"      = 'ready'
 WHERE "status" = 'reviewed';
