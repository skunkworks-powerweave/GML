CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"outline_lesson_id" uuid,
	"scheduled_date" date NOT NULL,
	"scheduled_time" time,
	"duration_min" integer,
	"topic" varchar(240),
	"status" varchar(16) DEFAULT 'planned' NOT NULL,
	"attended_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"observed" boolean DEFAULT false NOT NULL,
	"observation_cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" IN ('planned','in_progress','complete','cancelled')),
	CONSTRAINT "sessions_counts_nonneg_check" CHECK ("sessions"."attended_count" >= 0 AND "sessions"."total_count" >= 0),
	CONSTRAINT "sessions_attended_le_total_check" CHECK ("sessions"."attended_count" <= "sessions"."total_count"),
	CONSTRAINT "sessions_duration_check" CHECK ("sessions"."duration_min" IS NULL OR "sessions"."duration_min" > 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_outline_lesson_id_outline_lessons_id_fk" FOREIGN KEY ("outline_lesson_id") REFERENCES "public"."outline_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_observation_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("observation_cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_school_date_idx" ON "sessions" USING btree ("school_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "sessions_teacher_date_idx" ON "sessions" USING btree ("teacher_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "sessions_class_date_idx" ON "sessions" USING btree ("class_id","scheduled_date");