-- Make the quiz time limit and attempt cap enforceable SERVER-SIDE.
--
-- ── WHY THIS NEEDS A MIGRATION AND NOT JUST CODE ─────────────────────────────
--
-- `quizzes.time_limit_seconds` exists, has a CHECK constraint, and is enforced
-- ONLY by a countdown in the browser. `quiz_submissions` records `submitted_at`
-- and nothing else — there is no record of when an attempt STARTED. So the
-- server had nothing to measure a time limit against: it could not have
-- enforced one even if the code had tried.
--
-- The client-side timer is a courtesy to the learner. It is a setTimeout in a
-- component, and the submit action is a URL.
--
-- Likewise there was no attempt cap, and no column to hold one. A learner could
-- submit an assessment repeatedly until they passed, which for a programme that
-- issues completion on the basis of these scores is the difference between an
-- assessment and a formality.

-- Max attempts per learner per quiz. NULL = unlimited, which is the correct
-- default for every quiz that already exists: retroactively capping attempts on
-- a quiz learners have been retaking would lock people out of an assessment
-- they were told they could retry.
ALTER TABLE "quizzes"
  ADD COLUMN IF NOT EXISTS "max_attempts" smallint;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "quizzes"
    ADD CONSTRAINT "quizzes_max_attempts_range"
    CHECK ("max_attempts" IS NULL OR "max_attempts" BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- An attempt, opened when the learner loads the runner and closed when they
-- submit. This is what a server-side time limit measures against.
CREATE TABLE IF NOT EXISTS "quiz_attempts" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quiz_id"       uuid NOT NULL REFERENCES "quizzes"("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "started_at"    timestamp with time zone DEFAULT now() NOT NULL,
  -- Set when the attempt produces a submission. An attempt with a NULL
  -- submission_id that is older than the time limit is an abandoned one.
  "submission_id" uuid REFERENCES "quiz_submissions"("id") ON DELETE SET NULL,
  "closed_at"     timestamp with time zone
);--> statement-breakpoint

-- The hot lookups: "how many attempts has this learner made" (the cap) and
-- "what is their open attempt" (the timer).
CREATE INDEX IF NOT EXISTS "quiz_attempts_user_quiz_idx"
  ON "quiz_attempts" ("user_id", "quiz_id", "started_at" DESC);--> statement-breakpoint

-- At most ONE open attempt per learner per quiz.
--
-- Partial, over open attempts only, so the constraint does not stop a learner
-- making a second attempt after the first is closed — which is the whole point
-- of allowing retries. Without it, opening the runner in two tabs creates two
-- attempts and the earlier one becomes an invisible extra life.
CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_one_open_uq"
  ON "quiz_attempts" ("user_id", "quiz_id")
  WHERE "closed_at" IS NULL;
