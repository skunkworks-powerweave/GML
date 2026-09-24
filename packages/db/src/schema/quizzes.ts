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
    // RESTRICT, not SET NULL (migration 0029): nulling the only scope column
    // writes a row quizzes_one_scope forbids, so a SET NULL delete could never
    // succeed -- it failed as a CHECK violation the admin grid cannot explain.
    subjectId: uuid("subject_id").references(() => subjects.id, { onDelete: "restrict" }),
    rttSubjectId: uuid("rtt_subject_id").references(() => rttSubjects.id, { onDelete: "restrict" }),
    passThreshold: smallint("pass_threshold").notNull().default(60),
    // Spec 159 — Workflow Run 15 audit-closure MISS: optional time limit on
    // the quiz attempt. NULL = untimed (the default for every legacy quiz);
    // a positive integer = number of seconds the learner has to submit
    // before the runner auto-submits whatever it has collected. Range
    // enforced at the DB layer (60..7200) — 1 minute is the floor (anything
    // shorter is a UX trap, the learner can't realistically read questions
    // in under a minute) and 2 hours is the ceiling (the seed quizzes top
    // out at 30 questions × 90s per question ≈ 45 min; 2h is a comfortable
    // headroom for hypothetical long-form assessments without inviting
    // "infinite" timers that exist only to bypass the cap).
    timeLimitSeconds: integer("time_limit_seconds"),
    // Attempts allowed per learner. NULL = unlimited, which is the correct
    // default for every quiz that already exists -- retroactively capping a
    // quiz learners have been retaking would lock people out of an assessment
    // they were told they could retry.
    maxAttempts: smallint("max_attempts"),
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
    // Spec 159 — time_limit_seconds is NULLABLE (untimed quiz) or in
    // [60, 7200]. The CHECK uses the literal column name because Drizzle's
    // sql tagged-template emits the unqualified identifier inside CHECK
    // clauses (mirrors quizzes_pass_threshold_range above).
    check(
      "quizzes_max_attempts_range",
      sql`${t.maxAttempts} IS NULL OR ${t.maxAttempts} BETWEEN 1 AND 20`,
    ),
    check(
      "quizzes_time_limit_range",
      sql`${t.timeLimitSeconds} IS NULL OR ${t.timeLimitSeconds} BETWEEN 60 AND 7200`,
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

// ── quiz_attempts ─────────────────────────────────────────────────────────────
//
// Opened when a learner starts the runner, closed when they submit.
//
// WHY IT HAS TO EXIST. `quizzes.time_limit_seconds` was enforced ONLY by a
// countdown in the browser, because quiz_submissions records submitted_at and
// nothing else -- there was no record of when an attempt STARTED, so the server
// had nothing to measure against. It could not have enforced the limit even if
// the code had tried. And with no attempt record at all there was no attempt
// cap either: a learner could resubmit until they passed, which for a
// programme that issues completion on these scores is the difference between an
// assessment and a formality.
export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    submissionId: uuid("submission_id").references(() => quizSubmissions.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("quiz_attempts_user_quiz_idx").on(t.userId, t.quizId, t.startedAt),
    // At most ONE open attempt per learner per quiz. Partial, so a closed
    // attempt does not block a legitimate retry -- opening the runner in two
    // tabs would otherwise create two attempts and the earlier one becomes an
    // invisible extra life.
    uniqueIndex("quiz_attempts_one_open_uq")
      .on(t.userId, t.quizId)
      .where(sql`closed_at IS NULL`),
  ],
);

export type QuizAttempt = typeof quizAttempts.$inferSelect;
