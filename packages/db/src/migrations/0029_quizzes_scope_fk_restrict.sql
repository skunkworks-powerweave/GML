-- A quiz's subject can no longer be deleted out from under it.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--
-- quizzes.subject_id and quizzes.rtt_subject_id were ON DELETE SET NULL, and
-- quizzes_one_scope (0014) requires exactly one of them to be non-null. The
-- two cannot both hold: deleting a subject that has a quiz makes Postgres
-- write exactly the row the CHECK forbids, so the DELETE failed with 23514.
-- The admin grid maps 23503 to "still in use" and has no mapping for 23514,
-- so an administrator saw only "delete_failed" and no reason. Deleting a term
-- (which cascades to its RTT subjects) failed the same way.
--
-- RESTRICT says what is actually true -- the subject is still in use by a
-- quiz -- and raises 23503, which the grid already explains. CASCADE was the
-- other way to make the pair consistent, and the wrong one: it would delete the
-- quiz and, through quiz_submissions' own cascade, every learner's result.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- Re-add both constraints with ON DELETE set null (the 0014 definitions).
-- Nothing else depends on the delete action.

ALTER TABLE "quizzes" DROP CONSTRAINT IF EXISTS "quizzes_subject_id_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" DROP CONSTRAINT IF EXISTS "quizzes_rtt_subject_id_rtt_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE restrict ON UPDATE no action;
