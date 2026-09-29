// Grading scales: admin-defined bands that turn a percentage into a grade.
//
// One table of scales, each for what it grades -- students' test marks, quiz
// results, or observation rubric totals -- and its bands (A1 91-100, ...,
// E 0-32). Percentages are whole numbers; a band covers min_pct..max_pct
// inclusive. At most one scale per kind is the default, used when a quiz,
// assessment or rubric does not name its own. Design:
// docs/superpowers/specs/2026-09-28-teaching-records-design.md.

import { boolean, check, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** What a scale grades. */
export const GRADING_TARGETS = ["student", "quiz", "observation"] as const;
export type GradingTarget = (typeof GRADING_TARGETS)[number];

export const gradingScales = pgTable(
  "grading_scales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull(),
    appliesTo: varchar("applies_to", { length: 16 }).notNull().$type<GradingTarget>(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grading_scales_name_uq").on(t.name),
    // One default per kind: the scale used when nothing names its own.
    uniqueIndex("grading_scales_one_default_uq").on(t.appliesTo).where(sql`${t.isDefault}`),
    check("grading_scales_applies_to_check", sql`${t.appliesTo} IN ('student', 'quiz', 'observation')`),
  ],
);

export const gradingBands = pgTable(
  "grading_bands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scaleId: uuid("scale_id").notNull().references(() => gradingScales.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 32 }).notNull(),
    minPct: smallint("min_pct").notNull(),
    maxPct: smallint("max_pct").notNull(),
    isPass: boolean("is_pass").notNull().default(true),
    sequence: integer("sequence").notNull().default(0),
    description: varchar("description", { length: 200 }),
  },
  (t) => [
    uniqueIndex("grading_bands_scale_label_uq").on(t.scaleId, t.label),
    index("grading_bands_scale_idx").on(t.scaleId, t.sequence),
    check("grading_bands_range_check", sql`${t.minPct} >= 0 AND ${t.maxPct} <= 100 AND ${t.minPct} <= ${t.maxPct}`),
  ],
);

export type GradingScale = typeof gradingScales.$inferSelect;
export type GradingBand = typeof gradingBands.$inferSelect;
