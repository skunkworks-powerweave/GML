// Quizzes — multiple-choice assessments attached to a subject or rtt_subject.
// Revives the dropped spec 079 / 080 (quiz runner + builder) at the schema layer.
// Ports `LMS GML Frontend/forms.jsx::QuizRunner` (lines 157-266) into a real
// production stack:
//   1. `quizzes` carries the metadata (slug, title, pass threshold, scope).
//   2. `quiz_questions` carries the multiple-choice items in sequence.
//   3. `quiz_submissions` carries the per-user attempts (answers + score).
//
// Scope rule (CHECK constraint): a quiz is bound to exactly one of
// `subject_id` (curriculum subject) or `rtt_subject_id` (RTT training unit).
// The two domains stay distinct — same rule formDrafts uses for
// template_id vs observation_cycle_id.

import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { subjects } from "./subjects";
import { rttSubjects } from "./rtt";

export const quizzes = pgTable(
  "quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 60 }).notNull().unique(),
    title: varchar("title", { length: 200 }).notNull(),
    subjectId: uuid("subject_id").references(() => subjects.id, { onDelete: "set null" }),
    rttSubjectId: uuid("rtt_subject_id").references(() => rttSubjects.id, { onDelete: "set null" }),
    passThreshold: smallint("pass_threshold").notNull().default(60),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one of subject_id / rtt_subject_id must be non-null (scope is single).
    check(
      "quizzes_one_scope",
      sql`(${t.subjectId} IS NOT NULL AND ${t.rttSubjectId} IS NULL)
          OR (${t.subjectId} IS NULL AND ${t.rttSubjectId} IS NOT NULL)`,
    ),
    check(
      "quizzes_pass_threshold_range",
      sql`${t.passThreshold} BETWEEN 0 AND 100`,
    ),
    index("quizzes_subject_idx").on(t.subjectId),
    index("quizzes_rtt_subject_idx").on(t.rttSubjectId),
  ],
);

export const quizQuestions = pgTable(
  "quiz_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    prompt: text("prompt").notNull(),
    // options is a string array of choice labels (typically 2..6 entries).
    options: jsonb("options").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // 0-based index into `options`.
    correctIndex: smallint("correct_index").notNull(),
    explanation: text("explanation"),
  },
  (t) => [
    uniqueIndex("quiz_questions_quiz_sequence_uq").on(t.quizId, t.sequence),
  ],
);

export const quizSubmissions = pgTable(
  "quiz_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Per-question answer record: [{ questionId, selectedIndex }, ...].
    // Spec 146 — `selectedIndex` may be `null` to mark a skipped question.
    // Pre-146 rows store only number values; both shapes are valid.
    answers: jsonb("answers")
      .$type<Array<{ questionId: string; selectedIndex: number | null }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Percentage correct (0-100).
    score: smallint("score").notNull(),
    passed: boolean("passed").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("quiz_submissions_score_range", sql`${t.score} BETWEEN 0 AND 100`),
    index("quiz_submissions_user_idx").on(t.userId, t.submittedAt),
    index("quiz_submissions_quiz_idx").on(t.quizId, t.submittedAt),
  ],
);

export type Quiz = typeof quizzes.$inferSelect;
export type NewQuiz = typeof quizzes.$inferInsert;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type NewQuizQuestion = typeof quizQuestions.$inferInsert;
export type QuizSubmission = typeof quizSubmissions.$inferSelect;
export type NewQuizSubmission = typeof quizSubmissions.$inferInsert;
