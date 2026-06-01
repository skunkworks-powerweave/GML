CREATE TABLE "districts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"code" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "districts_name_unique" UNIQUE("name"),
	CONSTRAINT "districts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"address" text,
	"contact_phone" varchar(32),
	"head_teacher_name" varchar(160),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"school_id" uuid NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"phone" varchar(32),
	"subject_specialism" varchar(80),
	"joined_phase" varchar(16),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"district_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(24) NOT NULL,
	"sequence" integer NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	CONSTRAINT "phases_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "rtt_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rtt_session_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"status" "attendance_status" DEFAULT 'absent' NOT NULL,
	"marked_by_user_id" uuid,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rtt_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rtt_module_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"title" varchar(240) NOT NULL,
	"body_md" text,
	"video_id" uuid
);
--> statement-breakpoint
CREATE TABLE "rtt_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rtt_subject_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"title" varchar(240) NOT NULL,
	"description" text,
	"learning_objectives" text,
	"course_objectives" text,
	"assurance_of_learning" text,
	"evaluation_criteria" text,
	"textbook_refs" text
);
--> statement-breakpoint
CREATE TABLE "rtt_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rtt_subject_id" uuid NOT NULL,
	"title" varchar(240) NOT NULL,
	"file_key" text,
	"external_url" text,
	"sequence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rtt_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rtt_subject_id" uuid NOT NULL,
	"rtt_module_id" uuid,
	"sequence" integer NOT NULL,
	"title" varchar(240) NOT NULL,
	"scheduled_at" timestamp with time zone,
	"duration_min" integer,
	"type" varchar(32),
	"platform" varchar(80),
	"notes" text,
	"link_or_recording" text
);
--> statement-breakpoint
CREATE TABLE "rtt_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"code" varchar(32),
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"audience" "feedback_audience" NOT NULL,
	"schema" jsonb NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"pairing_id" uuid NOT NULL,
	"respondent_user_id" uuid,
	"responses" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentor_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_min" text,
	"notes" text,
	"recording_video_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentor_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mentor_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"status" "pairing_status" DEFAULT 'active' NOT NULL,
	"concept_note" text
);
--> statement-breakpoint
CREATE TABLE "mentors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" varchar(160) NOT NULL,
	"bio" text,
	"expertise_areas" jsonb DEFAULT '[]'::jsonb,
	"photo_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(48) NOT NULL,
	"teacher_id" uuid NOT NULL,
	"observer_id" uuid,
	"kind" "observation_kind" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" "observation_status" DEFAULT 'nominated' NOT NULL,
	"topic_taught" text,
	"grade_section" varchar(64),
	"students_present" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_cycles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "observation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"video_submission_id" uuid,
	"caption" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"responses" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_attendance" ADD CONSTRAINT "rtt_attendance_rtt_session_id_rtt_sessions_id_fk" FOREIGN KEY ("rtt_session_id") REFERENCES "public"."rtt_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_attendance" ADD CONSTRAINT "rtt_attendance_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_attendance" ADD CONSTRAINT "rtt_attendance_marked_by_user_id_users_id_fk" FOREIGN KEY ("marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_lessons" ADD CONSTRAINT "rtt_lessons_rtt_module_id_rtt_modules_id_fk" FOREIGN KEY ("rtt_module_id") REFERENCES "public"."rtt_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_modules" ADD CONSTRAINT "rtt_modules_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_readings" ADD CONSTRAINT "rtt_readings_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_sessions" ADD CONSTRAINT "rtt_sessions_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_sessions" ADD CONSTRAINT "rtt_sessions_rtt_module_id_rtt_modules_id_fk" FOREIGN KEY ("rtt_module_id") REFERENCES "public"."rtt_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtt_subjects" ADD CONSTRAINT "rtt_subjects_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_form_id_feedback_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."feedback_forms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_pairing_id_mentor_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."mentor_pairings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_respondent_user_id_users_id_fk" FOREIGN KEY ("respondent_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_meetings" ADD CONSTRAINT "mentor_meetings_pairing_id_mentor_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."mentor_pairings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD CONSTRAINT "mentor_pairings_mentor_id_mentors_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."mentors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD CONSTRAINT "mentor_pairings_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentors" ADD CONSTRAINT "mentors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD CONSTRAINT "observation_cycles_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD CONSTRAINT "observation_cycles_observer_id_users_id_fk" FOREIGN KEY ("observer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_evidence" ADD CONSTRAINT "observation_evidence_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_forms" ADD CONSTRAINT "observation_forms_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_forms" ADD CONSTRAINT "observation_forms_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schools_zone_idx" ON "schools" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "teachers_school_idx" ON "teachers" USING btree ("school_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_district_name_uq" ON "zones" USING btree ("district_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rtt_attendance_session_teacher_uq" ON "rtt_attendance" USING btree ("rtt_session_id","teacher_id");--> statement-breakpoint
CREATE INDEX "rtt_attendance_teacher_idx" ON "rtt_attendance" USING btree ("teacher_id","marked_at");--> statement-breakpoint
CREATE INDEX "rtt_lessons_module_idx" ON "rtt_lessons" USING btree ("rtt_module_id","sequence");--> statement-breakpoint
CREATE INDEX "rtt_modules_subject_idx" ON "rtt_modules" USING btree ("rtt_subject_id","sequence");--> statement-breakpoint
CREATE INDEX "rtt_readings_subject_idx" ON "rtt_readings" USING btree ("rtt_subject_id","sequence");--> statement-breakpoint
CREATE INDEX "rtt_sessions_subject_idx" ON "rtt_sessions" USING btree ("rtt_subject_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "rtt_subjects_term_name_uq" ON "rtt_subjects" USING btree ("term_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_phase_name_uq" ON "terms" USING btree ("phase_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_forms_kind_audience_version_uq" ON "feedback_forms" USING btree ("kind","audience","version");--> statement-breakpoint
CREATE INDEX "feedback_responses_pairing_idx" ON "feedback_responses" USING btree ("pairing_id");--> statement-breakpoint
CREATE INDEX "mentor_meetings_pairing_idx" ON "mentor_meetings" USING btree ("pairing_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mentor_pairings_mentor_teacher_started_uq" ON "mentor_pairings" USING btree ("mentor_id","teacher_id","started_at");--> statement-breakpoint
CREATE INDEX "mentor_pairings_status_idx" ON "mentor_pairings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "observation_cycles_teacher_idx" ON "observation_cycles" USING btree ("teacher_id","kind");--> statement-breakpoint
CREATE INDEX "observation_cycles_status_idx" ON "observation_cycles" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "observation_evidence_cycle_idx" ON "observation_evidence" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_forms_cycle_kind_uq" ON "observation_forms" USING btree ("cycle_id","kind");