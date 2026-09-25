-- A learner's progress through RTT content: the lessons and readings she has
-- marked done.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
--
-- Nothing recorded any. No table held lesson or reading completion, so the
-- subject page's "Resume" could only ever jump to module 1 and no one --
-- neither the teacher nor her mentor nor a programme admin -- could see what
-- she had worked through (F36). Quiz results and attendance were recorded
-- already (quiz_submissions, rtt_attendance) and are read, not duplicated.
--
-- ── THE TABLE ────────────────────────────────────────────────────────────────
--
-- One row per learner per item ticked, keyed by user as quiz_submissions is.
-- Exactly one of rtt_lesson_id / rtt_reading_id (rtt_progress_one_item), and
-- a learner ticks an item once (the two partial unique indexes), so a double
-- tap or a resubmitted form is a no-op rather than a second row.
--
-- CASCADE from the user and from the item: a tick on a lesson that no longer
-- exists means nothing, and RESTRICT would stop an administrator correcting a
-- curriculum once anyone had ticked part of it. Completion is self-reported;
-- it keeps the learner's place and is not evidence of anything.

CREATE TABLE IF NOT EXISTS "rtt_progress" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "rtt_lesson_id" uuid,
  "rtt_reading_id" uuid,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rtt_progress_one_item" CHECK (("rtt_lesson_id" IS NULL) <> ("rtt_reading_id" IS NULL))
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_progress"
    ADD CONSTRAINT "rtt_progress_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_progress"
    ADD CONSTRAINT "rtt_progress_rtt_lesson_id_rtt_lessons_id_fk"
    FOREIGN KEY ("rtt_lesson_id") REFERENCES "public"."rtt_lessons"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "rtt_progress"
    ADD CONSTRAINT "rtt_progress_rtt_reading_id_rtt_readings_id_fk"
    FOREIGN KEY ("rtt_reading_id") REFERENCES "public"."rtt_readings"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rtt_progress_user_lesson_uq"
  ON "rtt_progress" USING btree ("user_id", "rtt_lesson_id")
  WHERE "rtt_lesson_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rtt_progress_user_reading_uq"
  ON "rtt_progress" USING btree ("user_id", "rtt_reading_id")
  WHERE "rtt_reading_id" IS NOT NULL;--> statement-breakpoint

-- Closed to the Data API like every other table. _post/002 does that for the
-- tables that exist when it runs, and it runs once: on an upgraded database
-- this table is created after it, and would otherwise be readable through
-- PostgREST with the public anon key. Same two layers, same role guard.
ALTER TABLE "rtt_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  IF (SELECT count(*) = 2 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    REVOKE ALL ON TABLE public.rtt_progress FROM anon, authenticated;
  END IF;
END $$;
