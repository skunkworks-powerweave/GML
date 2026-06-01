// Curriculum subjects (English, Math, EVS, Hindi, Urdu, Science, Social Studies,
// Art, Ladakhi Studies, …). The spine that everything else in the repository
// hangs off of: classes (15), course_outlines (16), classroom sessions (17),
// resources (18).
//
// Distinct from `rttSubjects` (RTT training units bound to a phase/term).

import { boolean, check, integer, pgTable, smallint, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull().unique(),
    code: varchar("code", { length: 24 }).notNull().unique(),
    color: varchar("color", { length: 16 }), // CSS var or hex (e.g. var(--saffron), #D97757)
    gradesMin: smallint("grades_min"),
    gradesMax: smallint("grades_max"),
    displayOrder: integer("display_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // CHECK constraints — grade range stays within 1..12 (Indian schooling). Nullable.
    check("subjects_grades_min_check", sql`${t.gradesMin} IS NULL OR (${t.gradesMin} BETWEEN 1 AND 12)`),
    check("subjects_grades_max_check", sql`${t.gradesMax} IS NULL OR (${t.gradesMax} BETWEEN 1 AND 12)`),
    check(
      "subjects_grades_min_le_max_check",
      sql`${t.gradesMin} IS NULL OR ${t.gradesMax} IS NULL OR ${t.gradesMin} <= ${t.gradesMax}`,
    ),
  ],
);

export type Subject = typeof subjects.$inferSelect;
