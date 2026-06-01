CREATE TABLE "form_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid,
	"observation_cycle_id" uuid,
	"responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_drafts_one_scope" CHECK (("form_drafts"."template_id" IS NOT NULL AND "form_drafts"."observation_cycle_id" IS NULL)
          OR ("form_drafts"."template_id" IS NULL AND "form_drafts"."observation_cycle_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "form_drafts" ADD CONSTRAINT "form_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_drafts" ADD CONSTRAINT "form_drafts_template_id_feedback_forms_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."feedback_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_drafts" ADD CONSTRAINT "form_drafts_observation_cycle_id_observation_cycles_id_fk" FOREIGN KEY ("observation_cycle_id") REFERENCES "public"."observation_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_drafts_user_template_uq" ON "form_drafts" USING btree ("user_id","template_id") WHERE "form_drafts"."template_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "form_drafts_user_cycle_uq" ON "form_drafts" USING btree ("user_id","observation_cycle_id") WHERE "form_drafts"."observation_cycle_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "form_drafts_user_idx" ON "form_drafts" USING btree ("user_id","updated_at");