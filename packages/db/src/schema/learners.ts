// Learners — the children whom teachers teach. Highly sensitive PII.
// SM-9 enforcement: every server-side read of `learners` writes an audit_log row.
// See apps/web/src/app/admin/data/[entity]/page.tsx for the audit hook.

import { boolean, check, index, pgTable, smallint, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { classes } from "./classes";
import { schools } from "./geography";

export const learners = pgTable(
  "learners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "restrict" }), // 0031: was cascade
    schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }), // 0031: was cascade
    grade: smallint("grade").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    age: smallint("age"),
    guardian: varchar("guardian", { length: 120 }),
    rollNumber: varchar("roll_number", { length: 32 }),
    section: varchar("section", { length: 8 }),
    attendancePct: smallint("attendance_pct"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("learners_class_idx").on(t.classId),
    index("learners_school_grade_idx").on(t.schoolId, t.grade),
    check("learners_grade_check", sql`${t.grade} BETWEEN 1 AND 12`),
    check("learners_age_check", sql`${t.age} IS NULL OR (${t.age} BETWEEN 3 AND 25)`),
    check("learners_attendance_check", sql`${t.attendancePct} IS NULL OR (${t.attendancePct} BETWEEN 0 AND 100)`),
  ],
);

export type Learner = typeof learners.$inferSelect;
