-- Phases and terms get the integrity rules a write path needs.
--
-- Until the admin grid registered `phases` and `terms` (apps/web/src/admin/
-- entities/phases.ts, terms.ts), the seed was the only writer, so the rules
-- below held by construction. Now an administrator can type the values:
--
--   phases_dates_check        a phase cannot end before it starts. The
--                             dashboard's "current phase" is the one whose
--                             [start, end] contains today; an inverted range
--                             contains nothing and silently names no phase.
--   phases_sequence_uq        phases are ordered by sequence everywhere
--                             (dashboard, /repo/teachers); two with the same
--                             number make that order arbitrary.
--   terms_phase_sequence_uq   the same, per phase.
--
-- Safe on existing data: the seed writes Phase 1-3 with sequences 1-3 and
-- ascending dates, and Term 1 / Term 2 per phase -- and nothing else could
-- write these tables before this change.

ALTER TABLE "phases" ADD CONSTRAINT "phases_dates_check" CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phases_sequence_uq" ON "phases" USING btree ("sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "terms_phase_sequence_uq" ON "terms" USING btree ("phase_id","sequence");
