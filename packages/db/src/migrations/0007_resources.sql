CREATE TABLE "resource_subjects" (
	"resource_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	CONSTRAINT "resource_subjects_resource_id_subject_id_pk" PRIMARY KEY("resource_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(240) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"owner" varchar(120),
	"pages" integer,
	"file_key" text,
	"external_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_kind_check" CHECK ("resources"."kind" IN ('Policy','Guide','Handbook','Worksheet','Template','Routine','Calendar','Checklist','Lab-guide','Rubric','Other')),
	CONSTRAINT "resources_pages_check" CHECK ("resources"."pages" IS NULL OR "resources"."pages" > 0),
	CONSTRAINT "resources_has_source_check" CHECK ("resources"."file_key" IS NOT NULL OR "resources"."external_url" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "resource_subjects" ADD CONSTRAINT "resource_subjects_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_subjects" ADD CONSTRAINT "resource_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;