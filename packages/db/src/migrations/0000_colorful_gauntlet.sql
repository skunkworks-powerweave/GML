CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('view', 'download', 'upload', 'edit', 'delete', 'gate_pass', 'gate_fail', 'login', 'logout');--> statement-breakpoint
CREATE TYPE "public"."feedback_audience" AS ENUM('mentor', 'mentee');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('baseline', 'progress_1', 'progress_2', 'final');--> statement-breakpoint
CREATE TYPE "public"."observation_kind" AS ENUM('baseline', 'developmental', 'evaluative');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('nominated', 'pre_submitted', 'observed', 'post_submitted', 'complete');--> statement-breakpoint
CREATE TYPE "public"."pairing_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('teacher', 'observer', 'mentor', 'programme_admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."section_gate_slug" AS ENUM('mentorship', 'observation', 'tkt', 'ttt');--> statement-breakpoint
CREATE TYPE "public"."video_source" AS ENUM('direct', 'whatsapp', 'external_link', 'google_drive');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('received', 'queued', 'transcoding', 'ready', 'failed', 'review_pending', 'reviewed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" "audit_action" NOT NULL,
	"entity_type" varchar(64),
	"entity_id" text,
	"ip" varchar(64),
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "section_gate_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"gate_slug" "section_gate_slug" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(64),
	CONSTRAINT "section_gate_grants_expires_within_8h" CHECK ("section_gate_grants"."expires_at" <= "section_gate_grants"."granted_at" + interval '8 hours')
);
--> statement-breakpoint
CREATE TABLE "section_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" "section_gate_slug" NOT NULL,
	"password_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified" timestamp with time zone,
	"name" text,
	"phone" varchar(32),
	"image" text,
	"password_hash" text,
	"role" "role" DEFAULT 'teacher' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"default_locale" varchar(8) DEFAULT 'en' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_gate_grants" ADD CONSTRAINT "section_gate_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_gates" ADD CONSTRAINT "section_gates_rotated_by_user_id_users_id_fk" FOREIGN KEY ("rotated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "section_gate_grants_user_slug_idx" ON "section_gate_grants" USING btree ("user_id","gate_slug","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");