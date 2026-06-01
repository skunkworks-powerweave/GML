CREATE TABLE "user_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"density" varchar(16) DEFAULT 'regular' NOT NULL,
	"nav_style" varchar(16) DEFAULT 'labelled' NOT NULL,
	"font_scale" varchar(16) DEFAULT 'regular' NOT NULL,
	"high_contrast" boolean DEFAULT false NOT NULL,
	"reduced_motion" boolean DEFAULT false NOT NULL,
	"show_watermark" boolean DEFAULT true NOT NULL,
	"ui_language" varchar(8) DEFAULT 'en' NOT NULL,
	"ftux_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_prefs_density_check" CHECK ("user_prefs"."density" IN ('dense','regular','loose')),
	CONSTRAINT "user_prefs_nav_style_check" CHECK ("user_prefs"."nav_style" IN ('labelled','icons')),
	CONSTRAINT "user_prefs_font_scale_check" CHECK ("user_prefs"."font_scale" IN ('regular','large','xlarge')),
	CONSTRAINT "user_prefs_ui_language_check" CHECK ("user_prefs"."ui_language" IN ('en','hi','bo'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"body" text,
	"entity_type" varchar(64),
	"entity_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");