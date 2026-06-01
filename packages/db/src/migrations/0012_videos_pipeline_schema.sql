CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" varchar(80) NOT NULL,
	"size_bytes" integer,
	"checksum_sha256" varchar(64),
	"original_filename" text,
	"kind" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_kind_check" CHECK ("files"."kind" IN ('video_original','hls_master','hls_segment','poster','pdf','attachment')),
	CONSTRAINT "files_status_check" CHECK ("files"."status" IN ('uploading','stored','failed','quarantined'))
);
--> statement-breakpoint
CREATE TABLE "transcode_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_submission_id" uuid NOT NULL,
	"bull_job_id" varchar(128),
	"profile" varchar(8) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcode_jobs_profile_check" CHECK ("transcode_jobs"."profile" IN ('480p','720p')),
	CONSTRAINT "transcode_jobs_status_check" CHECK ("transcode_jobs"."status" IN ('queued','running','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "video_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"hls_master_key" text,
	"poster_key" text,
	"source" "video_source" NOT NULL,
	"external_url" text,
	"status" "video_status" DEFAULT 'received' NOT NULL,
	"duration_sec" integer,
	"width" integer,
	"height" integer,
	"processing_log" text,
	"submitted_by_user_id" uuid,
	"context_type" varchar(32) NOT NULL,
	"context_id" uuid,
	"caption_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "video_submissions_context_type_check" CHECK ("video_submissions"."context_type" IN ('observation_cycle','teach_back','mentor_meeting','mentee_quarterly','classroom_session','generic')),
	CONSTRAINT "video_submissions_ready_requires_hls_check" CHECK ("video_submissions"."status" <> 'ready' OR ("video_submissions"."hls_master_key" IS NOT NULL AND "video_submissions"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcode_jobs" ADD CONSTRAINT "transcode_jobs_video_submission_id_video_submissions_id_fk" FOREIGN KEY ("video_submission_id") REFERENCES "public"."video_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_submissions" ADD CONSTRAINT "video_submissions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_submissions" ADD CONSTRAINT "video_submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_bucket_objectkey_uq" ON "files" USING btree ("bucket","object_key");--> statement-breakpoint
CREATE INDEX "files_kind_status_idx" ON "files" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "transcode_jobs_video_idx" ON "transcode_jobs" USING btree ("video_submission_id");--> statement-breakpoint
CREATE INDEX "transcode_jobs_status_idx" ON "transcode_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "video_submissions_context_idx" ON "video_submissions" USING btree ("context_type","context_id");--> statement-breakpoint
CREATE INDEX "video_submissions_submitter_idx" ON "video_submissions" USING btree ("submitted_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "video_submissions_status_idx" ON "video_submissions" USING btree ("status","created_at");