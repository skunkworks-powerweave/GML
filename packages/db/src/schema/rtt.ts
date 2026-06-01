// RTT-content hierarchy (training programme spine): phases → terms → rttSubjects → rttModules → rttLessons.
// Plus rttSessions (cohort training sessions) + rttReadings + rttAttendance.
//
// v2 rename (2026-06-01, spec 013): the bare names (`subjects`, `lessons`, `sessions`)
// are reserved for curriculum-side concepts (school subjects, classroom sessions)
// shipped in specs 014-019. All RTT-content tables get the `rtt_` prefix here.
//
// Existing FK references within this file are internal — all use the same module's
// renamed exports.

import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { attendanceStatusEnum } from "./enums";
import { teachers } from "./geography";
import { users } from "./identity";

export const phases = pgTable("phases", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 24 }).notNull().unique(), // "Phase 1" / "Phase 2" / "Phase 3"
  sequence: integer("sequence").notNull(),
  startDate: timestamp("start_date", { withTimezone: true, mode: "date" }),
  endDate: timestamp("end_date", { withTimezone: true, mode: "date" }),
});

export const terms = pgTable(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phaseId: uuid("phase_id").notNull().references(() => phases.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    sequence: integer("sequence").notNull(),
  },
  (t) => [uniqueIndex("terms_phase_name_uq").on(t.phaseId, t.name)],
);

export const rttSubjects = pgTable(
  "rtt_subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    termId: uuid("term_id").notNull().references(() => terms.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    code: varchar("code", { length: 32 }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("rtt_subjects_term_name_uq").on(t.termId, t.name)],
);

export const rttModules = pgTable(
  "rtt_modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rttSubjectId: uuid("rtt_subject_id").notNull().references(() => rttSubjects.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    learningObjectives: text("learning_objectives"),
    courseObjectives: text("course_objectives"),
    assuranceOfLearning: text("assurance_of_learning"),
    evaluationCriteria: text("evaluation_criteria"),
    textbookRefs: text("textbook_refs"),
  },
  (t) => [index("rtt_modules_subject_idx").on(t.rttSubjectId, t.sequence)],
);

export const rttSessions = pgTable(
  "rtt_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rttSubjectId: uuid("rtt_subject_id").notNull().references(() => rttSubjects.id, { onDelete: "cascade" }),
    rttModuleId: uuid("rtt_module_id").references(() => rttModules.id, { onDelete: "set null" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    durationMin: integer("duration_min"),
    type: varchar("type", { length: 32 }), // synchronous|asynchronous|webinar|quiz
    platform: varchar("platform", { length: 80 }),
    notes: text("notes"),
    linkOrRecording: text("link_or_recording"),
  },
  (t) => [index("rtt_sessions_subject_idx").on(t.rttSubjectId, t.sequence)],
);

export const rttLessons = pgTable(
  "rtt_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rttModuleId: uuid("rtt_module_id").notNull().references(() => rttModules.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    bodyMd: text("body_md"),
    videoId: uuid("video_id"), // FK to video_submissions (lands with spec 036)
  },
  (t) => [index("rtt_lessons_module_idx").on(t.rttModuleId, t.sequence)],
);

export const rttReadings = pgTable(
  "rtt_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rttSubjectId: uuid("rtt_subject_id").notNull().references(() => rttSubjects.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    fileKey: text("file_key"), // MinIO object key (lands with spec 037)
    externalUrl: text("external_url"),
    sequence: integer("sequence").notNull().default(0),
  },
  (t) => [index("rtt_readings_subject_idx").on(t.rttSubjectId, t.sequence)],
);

export const rttAttendance = pgTable(
  "rtt_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rttSessionId: uuid("rtt_session_id").notNull().references(() => rttSessions.id, { onDelete: "cascade" }),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "cascade" }),
    status: attendanceStatusEnum("status").notNull().default("absent"),
    markedByUserId: uuid("marked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    markedAt: timestamp("marked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rtt_attendance_session_teacher_uq").on(t.rttSessionId, t.teacherId),
    index("rtt_attendance_teacher_idx").on(t.teacherId, t.markedAt),
  ],
);

export type Phase = typeof phases.$inferSelect;
export type Term = typeof terms.$inferSelect;
export type RttSubject = typeof rttSubjects.$inferSelect;
export type RttModule = typeof rttModules.$inferSelect;
export type RttSession = typeof rttSessions.$inferSelect;
export type RttLesson = typeof rttLessons.$inferSelect;
export type RttReading = typeof rttReadings.$inferSelect;
export type RttAttendance = typeof rttAttendance.$inferSelect;
