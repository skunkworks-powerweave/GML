CREATE TABLE "learners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"school_id" uuid NOT NULL,
	"grade" smallint NOT NULL,
	"name" varchar(160) NOT NULL,
	"age" smallint,
	"guardian" varchar(120),
	"roll_number" varchar(32),
	"section" varchar(8),
	"attendance_pct" smallint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "learners_grade_check" CHECK ("learners"."grade" BETWEEN 1 AND 12),
	CONSTRAINT "learners_age_check" CHECK ("learners"."age" IS NULL OR ("learners"."age" BETWEEN 3 AND 25)),
	CONSTRAINT "learners_attendance_check" CHECK ("learners"."attendance_pct" IS NULL OR ("learners"."attendance_pct" BETWEEN 0 AND 100))
);
--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learners_class_idx" ON "learners" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "learners_school_grade_idx" ON "learners" USING btree ("school_id","grade");