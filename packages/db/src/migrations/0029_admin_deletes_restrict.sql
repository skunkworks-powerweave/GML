-- A delete in the admin grid removes the row it names, and nothing else.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
--
-- The grid's delete (admin/data/[entity]/actions.ts) is a single DELETE that
-- leaves the rest to the foreign keys, and most of those were ON DELETE
-- CASCADE. One confirmed click therefore removed a whole subtree:
--
--   districts -> zones -> schools -> classes -> learners
--                                 -> sessions (classroom), learners
--   phases -> terms -> rtt_subjects -> rtt_modules -> rtt_lessons
--                                   -> rtt_sessions -> rtt_attendance
--                                   -> rtt_readings
--   teachers -> rtt_attendance
--   mentor_pairings -> mentor_meetings, feedback_responses
--   observation_cycles -> observation_forms, observation_evidence
--   subjects -> course_outlines -> outline_lessons
--
-- That broke the role model as well as losing data: learners and
-- rtt_attendance are mutateRoles ['super_admin'], and a programme_admin who is
-- refused a direct delete of either could erase every learner in a school by
-- deleting the school, and every attendance mark of a webinar by deleting the
-- webinar. The audit log kept the parent id and nothing about what went with
-- it.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────
--
-- A row that is a record of work (learners, classroom sessions, attendance,
-- meetings, feedback, observation forms and evidence), or that is administered
-- as an entity of its own in the grid, is never deleted as a side effect of
-- deleting another row. Those keys become RESTRICT, so the delete fails with
-- 23503 and the grid says what still references the row ("Remove or reassign
-- those first") instead of silently emptying it.
--
-- Kept as CASCADE, deliberately: resource_subjects (a link row that carries
-- nothing but the two ids), form_drafts (private autosave, not a submission),
-- and everything owned by a user row or a quiz, none of which the grid deletes.
--
-- Each constraint is dropped and re-added under its existing name, so
-- drizzle-kit (schema/*.ts declares onDelete "restrict" to match) sees no
-- difference. IF EXISTS keeps a partially applied run re-runnable.

ALTER TABLE "zones" DROP CONSTRAINT IF EXISTS "zones_district_id_districts_id_fk";--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" DROP CONSTRAINT IF EXISTS "schools_zone_id_zones_id_fk";--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" DROP CONSTRAINT IF EXISTS "classes_school_id_schools_id_fk";--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" DROP CONSTRAINT IF EXISTS "learners_class_id_classes_id_fk";--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" DROP CONSTRAINT IF EXISTS "learners_school_id_schools_id_fk";--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_school_id_schools_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_class_id_classes_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" DROP CONSTRAINT IF EXISTS "terms_phase_id_phases_id_fk";--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_subjects" DROP CONSTRAINT IF EXISTS "rtt_subjects_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_subjects" ADD CONSTRAINT "rtt_subjects_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_modules" DROP CONSTRAINT IF EXISTS "rtt_modules_rtt_subject_id_rtt_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_modules" ADD CONSTRAINT "rtt_modules_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_readings" DROP CONSTRAINT IF EXISTS "rtt_readings_rtt_subject_id_rtt_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_readings" ADD CONSTRAINT "rtt_readings_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_sessions" DROP CONSTRAINT IF EXISTS "rtt_sessions_rtt_subject_id_rtt_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_sessions" ADD CONSTRAINT "rtt_sessions_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_lessons" DROP CONSTRAINT IF EXISTS "rtt_lessons_rtt_module_id_rtt_modules_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_lessons" ADD CONSTRAINT "rtt_lessons_rtt_module_id_rtt_modules_id_fk" FOREIGN KEY ("rtt_module_id") REFERENCES "public"."rtt_modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_attendance" DROP CONSTRAINT IF EXISTS "rtt_attendance_rtt_session_id_rtt_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_attendance" ADD CONSTRAINT "rtt_attendance_rtt_session_id_rtt_sessions_id_fk" FOREIGN KEY ("rtt_session_id") REFERENCES "public"."rtt_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_attendance" DROP CONSTRAINT IF EXISTS "rtt_attendance_teacher_id_teachers_id_fk";--> statement-breakpoint
ALTER TABLE "rtt_attendance" ADD CONSTRAINT "rtt_attendance_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_meetings" DROP CONSTRAINT IF EXISTS "mentor_meetings_pairing_id_mentor_pairings_id_fk";--> statement-breakpoint
ALTER TABLE "mentor_meetings" ADD CONSTRAINT "mentor_meetings_pairing_id_mentor_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."mentor_pairings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" DROP CONSTRAINT IF EXISTS "feedback_responses_pairing_id_mentor_pairings_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_pairing_id_mentor_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."mentor_pairings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_forms" DROP CONSTRAINT IF EXISTS "observation_forms_cycle_id_observation_cycles_id_fk";--> statement-breakpoint
ALTER TABLE "observation_forms" ADD CONSTRAINT "observation_forms_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_evidence" DROP CONSTRAINT IF EXISTS "observation_evidence_cycle_id_observation_cycles_id_fk";--> statement-breakpoint
ALTER TABLE "observation_evidence" ADD CONSTRAINT "observation_evidence_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_outlines" DROP CONSTRAINT IF EXISTS "course_outlines_subject_id_subjects_id_fk";--> statement-breakpoint
ALTER TABLE "course_outlines" ADD CONSTRAINT "course_outlines_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_lessons" DROP CONSTRAINT IF EXISTS "outline_lessons_outline_id_course_outlines_id_fk";--> statement-breakpoint
ALTER TABLE "outline_lessons" ADD CONSTRAINT "outline_lessons_outline_id_course_outlines_id_fk" FOREIGN KEY ("outline_id") REFERENCES "public"."course_outlines"("id") ON DELETE restrict ON UPDATE no action;
