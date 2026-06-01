CREATE TABLE "course_outlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"term" smallint NOT NULL,
	"name" varchar(200) NOT NULL,
	"weeks" integer,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"owner_teacher_id" uuid,
	"status" varchar(16) DEFAULT 'planned' NOT NULL,
	"learning_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_outlines_grade_check" CHECK ("course_outlines"."grade" BETWEEN 1 AND 12),
	CONSTRAINT "course_outlines_term_check" CHECK ("course_outlines"."term" BETWEEN 1 AND 6),
	CONSTRAINT "course_outlines_weeks_check" CHECK ("course_outlines"."weeks" IS NULL OR "course_outlines"."weeks" >= 1),
	CONSTRAINT "course_outlines_status_check" CHECK ("course_outlines"."status" IN ('planned', 'in_progress', 'complete', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "outline_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outline_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"title" varchar(240) NOT NULL,
	"week" integer,
	CONSTRAINT "outline_lessons_sequence_check" CHECK ("outline_lessons"."sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "course_outlines" ADD CONSTRAINT "course_outlines_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_outlines" ADD CONSTRAINT "course_outlines_owner_teacher_id_teachers_id_fk" FOREIGN KEY ("owner_teacher_id") REFERENCES "public"."teachers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_lessons" ADD CONSTRAINT "outline_lessons_outline_id_course_outlines_id_fk" FOREIGN KEY ("outline_id") REFERENCES "public"."course_outlines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_outlines_subject_grade_term_uq" ON "course_outlines" USING btree ("subject_id","grade","term");--> statement-breakpoint
CREATE INDEX "course_outlines_subject_idx" ON "course_outlines" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outline_lessons_outline_sequence_uq" ON "outline_lessons" USING btree ("outline_id","sequence");--> statement-breakpoint
CREATE INDEX "outline_lessons_outline_idx" ON "outline_lessons" USING btree ("outline_id","sequence");