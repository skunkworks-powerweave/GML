// Course outlines (curriculum spine per subject × grade × term) + ordered outline lessons.
// Distinct from RTT modules/lessons (training units). The frontend's /repo/outlines
// drill-down browses these; classroom sessions (spec 017) reference an outline lesson.

import { check, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { subjects } from "./subjects";
import { teachers } from "./geography";

export const courseOutlines = pgTable(
  "course_outlines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "restrict" }), // 0031: was cascade
    grade: smallint("grade").notNull(),
    term: smallint("term").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    weeks: integer("weeks"),
    sessionsCount: integer("sessions_count").notNull().default(0),
    ownerTeacherId: uuid("owner_teacher_id").references(() => teachers.id, { onDelete: "set null" }),
    status: varchar("status", { length: 16 }).notNull().default("planned"),
    learningOutcomes: jsonb("learning_outcomes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Migration 0043: approval state (lib/approvals). A programme outline an
    // admin enters is approved as entered; a teacher's own plan starts as a draft.
    approvalStatus: varchar("approval_status", { length: 20 }).notNull().default("approved"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // One PROGRAMME outline per subject, grade and term, and one plan per
    // teacher per subject, grade and term. The single index this replaced
    // (course_outlines_subject_grade_term_uq) made a teacher's own plan
    // collide with the programme's.
    uniqueIndex("course_outlines_programme_uq").on(t.subjectId, t.grade, t.term).where(sql`${t.ownerTeacherId} IS NULL`),
    uniqueIndex("course_outlines_teacher_uq")
      .on(t.ownerTeacherId, t.subjectId, t.grade, t.term)
      .where(sql`${t.ownerTeacherId} IS NOT NULL`),
    index("course_outlines_owner_idx").on(t.ownerTeacherId),
    index("course_outlines_subject_idx").on(t.subjectId),
    check("course_outlines_grade_check", sql`${t.grade} BETWEEN 1 AND 12`),
    check("course_outlines_term_check", sql`${t.term} BETWEEN 1 AND 6`),
    check("course_outlines_weeks_check", sql`${t.weeks} IS NULL OR ${t.weeks} >= 1`),
    check("course_outlines_status_check", sql`${t.status} IN ('planned', 'in_progress', 'complete', 'archived')`),
    check("course_outlines_approval_status_check", sql`${t.approvalStatus} IN ('draft', 'pending', 'approved', 'changes_requested', 'rejected')`),
  ],
);

export const outlineLessons = pgTable(
  "outline_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outlineId: uuid("outline_id").notNull().references(() => courseOutlines.id, { onDelete: "restrict" }), // 0031: was cascade
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    week: integer("week"),
    // Migration 0043: the lesson plan itself.
    objectives: text("objectives"),
    activities: text("activities"),
    materials: text("materials"),
  },
  (t) => [
    uniqueIndex("outline_lessons_outline_sequence_uq").on(t.outlineId, t.sequence),
    index("outline_lessons_outline_idx").on(t.outlineId, t.sequence),
    check("outline_lessons_sequence_check", sql`${t.sequence} >= 1`),
  ],
);

export type CourseOutline = typeof courseOutlines.$inferSelect;
export type OutlineLesson = typeof outlineLessons.$inferSelect;
