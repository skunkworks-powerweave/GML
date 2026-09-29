ALTER TYPE "public"."attendance_status" ADD VALUE 'late';--> statement-breakpoint
CREATE TABLE "grading_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scale_id" uuid NOT NULL,
	"label" varchar(32) NOT NULL,
	"min_pct" smallint NOT NULL,
	"max_pct" smallint NOT NULL,
	"is_pass" boolean DEFAULT true NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"description" varchar(200),
	CONSTRAINT "grading_bands_range_check" CHECK ("grading_bands"."min_pct" >= 0 AND "grading_bands"."max_pct" <= 100 AND "grading_bands"."min_pct" <= "grading_bands"."max_pct")
);
--> statement-breakpoint
CREATE TABLE "grading_scales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"applies_to" varchar(16) NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_scales_applies_to_check" CHECK ("grading_scales"."applies_to" IN ('student', 'quiz', 'observation'))
);
--> statement-breakpoint
CREATE TABLE "observation_rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"grading_scale_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"note" text,
	"scored_by_user_id" uuid,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_scores_score_check" CHECK ("observation_scores"."score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rubric_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rubric_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"max_score" smallint DEFAULT 4 NOT NULL,
	CONSTRAINT "rubric_criteria_max_score_check" CHECK ("rubric_criteria"."max_score" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "account_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"email" varchar(254) NOT NULL,
	"phone" varchar(32),
	"school_id" uuid,
	"requested_role" varchar(16) DEFAULT 'teacher' NOT NULL,
	"message" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_requests_role_check" CHECK ("account_requests"."requested_role" IN ('teacher', 'mentor', 'observer')),
	CONSTRAINT "account_requests_status_check" CHECK ("account_requests"."status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_type" varchar(32) NOT NULL,
	"item_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"note" text,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending', 'approved', 'changes_requested', 'rejected')),
	CONSTRAINT "approvals_item_type_check" CHECK ("approvals"."item_type" IN ('lesson_plan', 'session', 'assessment', 'teach_back', 'observation_signoff', 'account_request')),
	CONSTRAINT "approvals_decided_check" CHECK (("approvals"."status" = 'pending') = ("approvals"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "assessment_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"marks" numeric(6, 2),
	"absent" boolean DEFAULT false NOT NULL,
	"remark" varchar(240),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_marks_marks_check" CHECK ("assessment_marks"."marks" IS NULL OR "assessment_marks"."marks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"section" varchar(8),
	"term" smallint,
	"title" varchar(200) NOT NULL,
	"max_marks" integer NOT NULL,
	"assessed_on" date,
	"grading_scale_id" uuid,
	"approval_status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessments_max_marks_check" CHECK ("assessments"."max_marks" BETWEEN 1 AND 1000),
	CONSTRAINT "assessments_term_check" CHECK ("assessments"."term" IS NULL OR "assessments"."term" BETWEEN 1 AND 6),
	CONSTRAINT "assessments_approval_status_check" CHECK ("assessments"."approval_status" IN ('draft', 'pending', 'approved', 'changes_requested', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "session_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"status" "attendance_status" DEFAULT 'present' NOT NULL,
	"marked_by_user_id" uuid,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"section" varchar(8),
	"subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_classes_teacher_class_section_uq" UNIQUE NULLS NOT DISTINCT("teacher_id","class_id","section")
);
--> statement-breakpoint
DROP INDEX "course_outlines_subject_grade_term_uq";--> statement-breakpoint
ALTER TABLE "system_settings" ALTER COLUMN "notifications_enabled" SET DEFAULT '["helpdesk.ticket","cycle.assigned","cycle.complete","video.transcoded","meeting.scheduled","meeting.cancelled","pairing.final_submitted","approval"]'::jsonb;--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD COLUMN "rubric_id" uuid;--> statement-breakpoint
ALTER TABLE "course_outlines" ADD COLUMN "approval_status" varchar(20) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "outline_lessons" ADD COLUMN "objectives" text;--> statement-breakpoint
ALTER TABLE "outline_lessons" ADD COLUMN "activities" text;--> statement-breakpoint
ALTER TABLE "outline_lessons" ADD COLUMN "materials" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "section" varchar(8);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "approval_status" varchar(20) DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "grading_scale_id" uuid;--> statement-breakpoint
ALTER TABLE "grading_bands" ADD CONSTRAINT "grading_bands_scale_id_grading_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."grading_scales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_rubrics" ADD CONSTRAINT "observation_rubrics_grading_scale_id_grading_scales_id_fk" FOREIGN KEY ("grading_scale_id") REFERENCES "public"."grading_scales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_scores" ADD CONSTRAINT "observation_scores_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_scores" ADD CONSTRAINT "observation_scores_criterion_id_rubric_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."rubric_criteria"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_scores" ADD CONSTRAINT "observation_scores_scored_by_user_id_users_id_fk" FOREIGN KEY ("scored_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_rubric_id_observation_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."observation_rubrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_requests" ADD CONSTRAINT "account_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_requests" ADD CONSTRAINT "account_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_requests" ADD CONSTRAINT "account_requests_created_user_id_users_id_fk" FOREIGN KEY ("created_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_marks" ADD CONSTRAINT "assessment_marks_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_marks" ADD CONSTRAINT "assessment_marks_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_grading_scale_id_grading_scales_id_fk" FOREIGN KEY ("grading_scale_id") REFERENCES "public"."grading_scales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_marked_by_user_id_users_id_fk" FOREIGN KEY ("marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_classes" ADD CONSTRAINT "teacher_classes_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_classes" ADD CONSTRAINT "teacher_classes_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_classes" ADD CONSTRAINT "teacher_classes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grading_bands_scale_label_uq" ON "grading_bands" USING btree ("scale_id","label");--> statement-breakpoint
CREATE INDEX "grading_bands_scale_idx" ON "grading_bands" USING btree ("scale_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_scales_name_uq" ON "grading_scales" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_scales_one_default_uq" ON "grading_scales" USING btree ("applies_to") WHERE "grading_scales"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "observation_rubrics_name_uq" ON "observation_rubrics" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_rubrics_one_default_uq" ON "observation_rubrics" USING btree ("is_default") WHERE "observation_rubrics"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "observation_scores_cycle_criterion_uq" ON "observation_scores" USING btree ("cycle_id","criterion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rubric_criteria_rubric_sequence_uq" ON "rubric_criteria" USING btree ("rubric_id","sequence");--> statement-breakpoint
CREATE INDEX "account_requests_status_idx" ON "account_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_requests_one_pending_uq" ON "account_requests" USING btree (lower("email")) WHERE "account_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_queue_idx" ON "approvals" USING btree ("status","item_type","submitted_at");--> statement-breakpoint
CREATE INDEX "approvals_item_idx" ON "approvals" USING btree ("item_type","item_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_uq" ON "approvals" USING btree ("item_type","item_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_marks_assessment_learner_uq" ON "assessment_marks" USING btree ("assessment_id","learner_id");--> statement-breakpoint
CREATE INDEX "assessments_teacher_date_idx" ON "assessments" USING btree ("teacher_id","assessed_on");--> statement-breakpoint
CREATE INDEX "assessments_class_idx" ON "assessments" USING btree ("class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_attendance_session_learner_uq" ON "session_attendance" USING btree ("session_id","learner_id");--> statement-breakpoint
CREATE INDEX "session_attendance_learner_idx" ON "session_attendance" USING btree ("learner_id","marked_at");--> statement-breakpoint
CREATE INDEX "teacher_classes_class_idx" ON "teacher_classes" USING btree ("class_id");--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD CONSTRAINT "observation_cycles_rubric_id_observation_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."observation_rubrics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_grading_scale_id_grading_scales_id_fk" FOREIGN KEY ("grading_scale_id") REFERENCES "public"."grading_scales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_outlines_programme_uq" ON "course_outlines" USING btree ("subject_id","grade","term") WHERE "course_outlines"."owner_teacher_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "course_outlines_teacher_uq" ON "course_outlines" USING btree ("owner_teacher_id","subject_id","grade","term") WHERE "course_outlines"."owner_teacher_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "course_outlines_owner_idx" ON "course_outlines" USING btree ("owner_teacher_id");--> statement-breakpoint
CREATE INDEX "sessions_approval_idx" ON "sessions" USING btree ("approval_status");--> statement-breakpoint
ALTER TABLE "course_outlines" ADD CONSTRAINT "course_outlines_approval_status_check" CHECK ("course_outlines"."approval_status" IN ('draft', 'pending', 'approved', 'changes_requested', 'rejected'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_approval_status_check" CHECK ("sessions"."approval_status" IN ('draft', 'pending', 'approved', 'changes_requested', 'rejected'));
-- Turning the new "approval" kind on in an existing deployment's settings row
-- is _post/014_approval_notification_kind.sql: that lane runs after _post/012,
-- which would otherwise set the column default back without it.
