-- Spec 124 — system_settings singleton table for admin platform-wide knobs.
-- See packages/db/src/schema/systemSettings.ts for column rationale and the
-- defence-in-depth reasoning behind the CHECK constraint singleton pattern.

CREATE TABLE "system_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"programme_name" varchar(200) DEFAULT 'Goldenmile RTT' NOT NULL,
	"academic_year" varchar(16) DEFAULT '2026-27' NOT NULL,
	"video_default_quality" varchar(8) DEFAULT '480p' NOT NULL,
	"video_max_upload_mb" integer DEFAULT 500 NOT NULL,
	"notifications_enabled" jsonb DEFAULT '["cycle.assigned","video.transcoded","meeting.scheduled"]'::jsonb NOT NULL,
	"backup_retention_days" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_singleton" CHECK ("system_settings"."id" = '00000000-0000-0000-0000-000000000001'::uuid)
);
--> statement-breakpoint
-- Bootstrap the singleton row so /admin/system-settings has something to read on
-- a fresh deployment. The application bootstrap (seed.ts::bootstrapSystemSettings)
-- also INSERTs idempotently, but inserting here means migrate-only deployments are
-- also self-consistent.
INSERT INTO "system_settings" ("id") VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT ("id") DO NOTHING;
