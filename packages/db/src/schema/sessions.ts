// Classroom sessions — teaching sessions a teacher delivers to a class.
// Distinct from rtt_sessions (RTT training cohort sessions).
// Optionally links to an outline_lesson (curriculum spine) and/or an observation_cycle.

import { boolean, check, date, index, integer, pgTable, time, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { schools, teachers } from "./geography";
import { subjects } from "./subjects";
import { classes } from "./classes";
import { outlineLessons } from "./outlines";
import { observationCycles } from "./observation";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }), // 0031: was cascade
    classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "restrict" }), // 0031: was cascade
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "restrict" }),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),
    outlineLessonId: uuid("outline_lesson_id").references(() => outlineLessons.id, { onDelete: "set null" }),
    scheduledDate: date("scheduled_date").notNull(),
    scheduledTime: time("scheduled_time"),
    durationMin: integer("duration_min"),
    topic: varchar("topic", { length: 240 }),
    status: varchar("status", { length: 16 }).notNull().default("planned"),
    attendedCount: integer("attended_count").notNull().default(0),
    totalCount: integer("total_count").notNull().default(0),
    observed: boolean("observed").notNull().default(false),
    observationCycleId: uuid("observation_cycle_id").references(() => observationCycles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_school_date_idx").on(t.schoolId, t.scheduledDate),
    index("sessions_teacher_date_idx").on(t.teacherId, t.scheduledDate),
    index("sessions_class_date_idx").on(t.classId, t.scheduledDate),
    check("sessions_status_check", sql`${t.status} IN ('planned','in_progress','complete','cancelled')`),
    check("sessions_counts_nonneg_check", sql`${t.attendedCount} >= 0 AND ${t.totalCount} >= 0`),
    check("sessions_attended_le_total_check", sql`${t.attendedCount} <= ${t.totalCount}`),
    check("sessions_duration_check", sql`${t.durationMin} IS NULL OR ${t.durationMin} > 0`),
  ],
);

export type Session = typeof sessions.$inferSelect;
