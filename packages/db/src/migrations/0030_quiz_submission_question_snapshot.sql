-- Freeze, with each quiz submission, the questions the learner was asked.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--
-- quiz_submissions.answers stores {questionId, selectedIndex} and nothing
-- else, and the result page rebuilt everything else -- the prompt, the
-- options, which one was correct -- from the LIVE quiz_questions rows. The
-- quiz editor rewrites those rows in place by position. So inserting a
-- warm-up question on a live quiz turned every past result into answers to
-- different questions ("2 of 3 answered, 0 correct" beside a stored 100%),
-- and moving a correctIndex re-graded history while the score stayed put.
-- The question a learner actually answered was lost.
--
-- submitQuizAttempt now writes the questions it graded against into this
-- column, and the result page reads them from here.
--
-- ── THE BACKFILL ─────────────────────────────────────────────────────────────
--
-- Existing submissions are given the quiz's questions as they stand now. For
-- a quiz that has not been edited since, that is exactly what was asked; for
-- one that has, it is no worse than what the result page already showed, and
-- it stops any FURTHER edit from rewriting those results.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- ALTER TABLE "quiz_submissions" DROP COLUMN "question_snapshot";
-- The result page falls back to the live rows when the column is NULL.

ALTER TABLE "quiz_submissions" ADD COLUMN IF NOT EXISTS "question_snapshot" jsonb;--> statement-breakpoint

UPDATE "quiz_submissions" s
   SET "question_snapshot" = (
     SELECT coalesce(
       jsonb_agg(
         jsonb_build_object(
           'id', q."id",
           'prompt', q."prompt",
           'options', q."options",
           'correctIndex', q."correct_index",
           'explanation', q."explanation"
         )
         ORDER BY q."sequence"
       ),
       '[]'::jsonb
     )
     FROM "quiz_questions" q
     WHERE q."quiz_id" = s."quiz_id"
   )
 WHERE s."question_snapshot" IS NULL;
