// Classroom observation — cycles, forms (pre/post/observer/summary), evidence videos.

import { boolean, check, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { observationKindEnum, observationStatusEnum } from "./enums";
import { teachers } from "./geography";
import { users } from "./identity";
import { subjects } from "./subjects";
import { videoSubmissions } from "./videos";
import { gradingScales } from "./grading";

export const observationCycles = pgTable(
  "observation_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 48 }).notNull().unique(), // e.g. "OBS-2026-001"
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),
    observerId: uuid("observer_id").references(() => users.id, { onDelete: "set null" }),
    kind: observationKindEnum("kind").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    status: observationStatusEnum("status").notNull().default("nominated"),
    // v2 (spec 020): subject FK + topic + video duration
    subjectId: uuid("subject_id").references(() => subjects.id, { onDelete: "set null" }),
    // Migration 0043: the scored rubric the observer used (NULL = the free-text
    // rubric of cycles before scored rubrics existed).
    rubricId: uuid("rubric_id").references(() => observationRubrics.id, { onDelete: "set null" }),
    topic: varchar("topic", { length: 240 }),
    videoMin: integer("video_min"),
    topicTaught: text("topic_taught"),
    gradeSection: varchar("grade_section", { length: 64 }),
    studentsPresent: text("students_present"),
    remark: text("remark"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("observation_cycles_teacher_idx").on(t.teacherId, t.kind),
    index("observation_cycles_status_idx").on(t.status, t.scheduledAt),
    index("observation_cycles_subject_idx").on(t.subjectId),
    // lib/authz.ts checks observer_id on every cycle access, so this column is
    // on the authorization path for the entire observation module.
    index("observation_cycles_observer_idx").on(t.observerId),
    check("observation_cycles_video_min_check", sql`${t.videoMin} IS NULL OR ${t.videoMin} >= 0`),
  ],
);

export const observationForms = pgTable(
  "observation_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull().references(() => observationCycles.id, { onDelete: "restrict" }), // 0031: was cascade
    kind: varchar("kind", { length: 16 }).notNull(), // pre|post|observer|summary
    schemaVersion: text("schema_version").notNull().default("1"),
    responses: jsonb("responses").$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("observation_forms_cycle_kind_uq").on(t.cycleId, t.kind)],
);

export const observationEvidence = pgTable(
  "observation_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull().references(() => observationCycles.id, { onDelete: "restrict" }), // 0031: was cascade
    // Spec 143 — FK to video_submissions hardened at the TS + SQL layers. ON DELETE SET NULL
    // mirrors the existing app-level contract: deleting a video_submission must not cascade
    // and wipe the observation evidence row (the row still carries the caption + cycle link
    // and is a legitimate audit artefact even when the underlying video has been purged).
    videoSubmissionId: uuid("video_submission_id").references(() => videoSubmissions.id, { onDelete: "set null" }),
    caption: text("caption"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("observation_evidence_cycle_idx").on(t.cycleId)],
);

// ── Scored rubrics (migration 0043) ──────────────────────────────────────────
// An admin-defined rubric: criteria, each scored 0..max_score by the observer
// on the observer form. The cycle's total, as a percentage, gets a band from
// the rubric's grading scale (or the default observation scale).

export const observationRubrics = pgTable(
  "observation_rubrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    gradingScaleId: uuid("grading_scale_id").references(() => gradingScales.id, { onDelete: "set null" }),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("observation_rubrics_name_uq").on(t.name),
    uniqueIndex("observation_rubrics_one_default_uq").on(t.isDefault).where(sql`${t.isDefault}`),
  ],
);

export const rubricCriteria = pgTable(
  "rubric_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rubricId: uuid("rubric_id").notNull().references(() => observationRubrics.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    maxScore: smallint("max_score").notNull().default(4),
  },
  (t) => [
    uniqueIndex("rubric_criteria_rubric_sequence_uq").on(t.rubricId, t.sequence),
    check("rubric_criteria_max_score_check", sql`${t.maxScore} BETWEEN 1 AND 10`),
  ],
);

export const observationScores = pgTable(
  "observation_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull().references(() => observationCycles.id, { onDelete: "cascade" }),
    criterionId: uuid("criterion_id").notNull().references(() => rubricCriteria.id, { onDelete: "restrict" }),
    score: smallint("score").notNull(),
    note: text("note"),
    scoredByUserId: uuid("scored_by_user_id").references(() => users.id, { onDelete: "set null" }),
    scoredAt: timestamp("scored_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("observation_scores_cycle_criterion_uq").on(t.cycleId, t.criterionId),
    check("observation_scores_score_check", sql`${t.score} >= 0`),
  ],
);

export type ObservationCycle = typeof observationCycles.$inferSelect;
export type ObservationForm = typeof observationForms.$inferSelect;
export type ObservationEvidence = typeof observationEvidence.$inferSelect;
export type ObservationRubric = typeof observationRubrics.$inferSelect;
export type RubricCriterion = typeof rubricCriteria.$inferSelect;
export type ObservationScore = typeof observationScores.$inferSelect;
