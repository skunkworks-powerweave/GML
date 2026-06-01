// RTT content hierarchy: phases → terms → subjects → modules / sessions / readings.
// Attendance per session-teacher.

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

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    termId: uuid("term_id").notNull().references(() => terms.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    code: varchar("code", { length: 32 }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("subjects_term_name_uq").on(t.termId, t.name)],
);

export const subjectModules = pgTable(
  "subject_modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    learningObjectives: text("learning_objectives"),
    courseObjectives: text("course_objectives"),
    assuranceOfLearning: text("assurance_of_learning"),
    evaluationCriteria: text("evaluation_criteria"),
    textbookRefs: text("textbook_refs"),
  },
  (t) => [index("subject_modules_subject_idx").on(t.subjectId, t.sequence)],
);

export const sessionsRtt = pgTable(
  "sessions_rtt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
    moduleId: uuid("module_id").references(() => subjectModules.id, { onDelete: "set null" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    durationMin: integer("duration_min"),
    type: varchar("type", { length: 32 }), // synchronous|asynchronous|webinar|quiz
    platform: varchar("platform", { length: 80 }),
    notes: text("notes"),
    linkOrRecording: text("link_or_recording"),
  },
  (t) => [index("sessions_rtt_subject_idx").on(t.subjectId, t.sequence)],
);

export const lessons = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: uuid("module_id").notNull().references(() => subjectModules.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    bodyMd: text("body_md"),
    videoId: uuid("video_id"), // FK to video_submissions (spec 022+)
  },
  (t) => [index("lessons_module_idx").on(t.moduleId, t.sequence)],
);

export const readings = pgTable(
  "readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    fileKey: text("file_key"), // MinIO object key (lands with spec 022)
    externalUrl: text("external_url"),
    sequence: integer("sequence").notNull().default(0),
  },
  (t) => [index("readings_subject_idx").on(t.subjectId, t.sequence)],
);

export const attendance = pgTable(
  "attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessionsRtt.id, { onDelete: "cascade" }),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "cascade" }),
    status: attendanceStatusEnum("status").notNull().default("absent"),
    markedByUserId: uuid("marked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    markedAt: timestamp("marked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("attendance_session_teacher_uq").on(t.sessionId, t.teacherId),
    index("attendance_teacher_idx").on(t.teacherId, t.markedAt),
  ],
);

export type Phase = typeof phases.$inferSelect;
export type Term = typeof terms.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type SubjectModule = typeof subjectModules.$inferSelect;
export type SessionRtt = typeof sessionsRtt.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type Reading = typeof readings.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
