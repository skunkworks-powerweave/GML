ALTER TYPE "public"."pairing_status" ADD VALUE 'review' BEFORE 'paused';--> statement-breakpoint
ALTER TYPE "public"."pairing_status" ADD VALUE 'complete';--> statement-breakpoint
ALTER TYPE "public"."section_gate_slug" ADD VALUE 'admin' BEFORE 'tkt';--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "action" SET DATA TYPE varchar(64);--> statement-breakpoint
DROP TYPE "public"."audit_action";