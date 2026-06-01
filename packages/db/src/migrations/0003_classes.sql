CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"stage" varchar(16) NOT NULL,
	"students_count" integer DEFAULT 0 NOT NULL,
	"sections_count" smallint DEFAULT 1 NOT NULL,
	"class_teacher_name" varchar(160),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_grade_check" CHECK ("classes"."grade" BETWEEN 1 AND 12),
	CONSTRAINT "classes_sections_count_check" CHECK ("classes"."sections_count" >= 1),
	CONSTRAINT "classes_students_count_check" CHECK ("classes"."students_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classes_school_grade_uq" ON "classes" USING btree ("school_id","grade");--> statement-breakpoint
CREATE INDEX "classes_school_idx" ON "classes" USING btree ("school_id");