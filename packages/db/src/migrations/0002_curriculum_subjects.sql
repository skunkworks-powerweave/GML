CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"code" varchar(24) NOT NULL,
	"color" varchar(16),
	"grades_min" smallint,
	"grades_max" smallint,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_name_unique" UNIQUE("name"),
	CONSTRAINT "subjects_code_unique" UNIQUE("code"),
	CONSTRAINT "subjects_grades_min_check" CHECK ("subjects"."grades_min" IS NULL OR ("subjects"."grades_min" BETWEEN 1 AND 12)),
	CONSTRAINT "subjects_grades_max_check" CHECK ("subjects"."grades_max" IS NULL OR ("subjects"."grades_max" BETWEEN 1 AND 12)),
	CONSTRAINT "subjects_grades_min_le_max_check" CHECK ("subjects"."grades_min" IS NULL OR "subjects"."grades_max" IS NULL OR "subjects"."grades_min" <= "subjects"."grades_max")
);
