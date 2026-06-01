ALTER TABLE "schools" ADD COLUMN "code" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "hindi_name" varchar(160);--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "current_phase_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hindi_name" varchar(160);--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD COLUMN "current_quarter" smallint;--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD COLUMN "meetings_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD COLUMN "last_meeting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mentors" ADD COLUMN "hindi_name" varchar(160);--> statement-breakpoint
ALTER TABLE "mentors" ADD COLUMN "base_location" varchar(80);--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD COLUMN "topic" varchar(240);--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD COLUMN "video_min" integer;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_current_phase_id_phases_id_fk" FOREIGN KEY ("current_phase_id") REFERENCES "public"."phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD CONSTRAINT "observation_cycles_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_cycles_subject_idx" ON "observation_cycles" USING btree ("subject_id");--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD CONSTRAINT "mentor_pairings_quarter_check" CHECK ("mentor_pairings"."current_quarter" IS NULL OR ("mentor_pairings"."current_quarter" BETWEEN 1 AND 4));--> statement-breakpoint
ALTER TABLE "mentor_pairings" ADD CONSTRAINT "mentor_pairings_meetings_count_check" CHECK ("mentor_pairings"."meetings_count" >= 0);--> statement-breakpoint
ALTER TABLE "observation_cycles" ADD CONSTRAINT "observation_cycles_video_min_check" CHECK ("observation_cycles"."video_min" IS NULL OR "observation_cycles"."video_min" >= 0);