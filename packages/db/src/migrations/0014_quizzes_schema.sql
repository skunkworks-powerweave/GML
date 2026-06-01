CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(60) NOT NULL,
	"title" varchar(200) NOT NULL,
	"subject_id" uuid,
	"rtt_subject_id" uuid,
	"pass_threshold" smallint DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_slug_unique" UNIQUE("slug"),
	CONSTRAINT "quizzes_one_scope" CHECK (("quizzes"."subject_id" IS NOT NULL AND "quizzes"."rtt_subject_id" IS NULL)
          OR ("quizzes"."subject_id" IS NULL AND "quizzes"."rtt_subject_id" IS NOT NULL)),
	CONSTRAINT "quizzes_pass_threshold_range" CHECK ("quizzes"."pass_threshold" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct_index" smallint NOT NULL,
	"explanation" text
);
--> statement-breakpoint
CREATE TABLE "quiz_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" smallint NOT NULL,
	"passed" boolean NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_submissions_score_range" CHECK ("quiz_submissions"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_rtt_subject_id_rtt_subjects_id_fk" FOREIGN KEY ("rtt_subject_id") REFERENCES "public"."rtt_subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_submissions" ADD CONSTRAINT "quiz_submissions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_submissions" ADD CONSTRAINT "quiz_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quizzes_subject_idx" ON "quizzes" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "quizzes_rtt_subject_idx" ON "quizzes" USING btree ("rtt_subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_questions_quiz_sequence_uq" ON "quiz_questions" USING btree ("quiz_id","sequence");--> statement-breakpoint
CREATE INDEX "quiz_submissions_user_idx" ON "quiz_submissions" USING btree ("user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "quiz_submissions_quiz_idx" ON "quiz_submissions" USING btree ("quiz_id","submitted_at");
