// Classes — "Grade N at School S". The unit teachers teach in their classroom.
// Learners (spec 019) belong to a class. Classroom sessions (spec 017) reference
// a class. Repo drill-down `/repo/class/[id]` (spec 048) shows the roster.

import { boolean, check, index, integer, pgTable, smallint, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { schools } from "./geography";

export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: uuid("school_id").notNull().references(() => schools.id, { onDelete: "restrict" }), // 0031: was cascade
    grade: smallint("grade").notNull(),
    stage: varchar("stage", { length: 16 }).notNull(), // Primary | Middle | High (or future Pre-Primary)
    studentsCount: integer("students_count").notNull().default(0),
    sectionsCount: smallint("sections_count").notNull().default(1),
    classTeacherName: varchar("class_teacher_name", { length: 160 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("classes_school_grade_uq").on(t.schoolId, t.grade),
    index("classes_school_idx").on(t.schoolId),
    check("classes_grade_check", sql`${t.grade} BETWEEN 1 AND 12`),
    check("classes_sections_count_check", sql`${t.sectionsCount} >= 1`),
    check("classes_students_count_check", sql`${t.studentsCount} >= 0`),
  ],
);

export type Class = typeof classes.$inferSelect;
