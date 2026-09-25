// Classroom observation — cycles, forms (pre/post/observer/summary), evidence videos.

import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { observationKindEnum, observationStatusEnum } from "./enums";
import { teachers } from "./geography";
import { users } from "./identity";
import { subjects } from "./subjects";
import { videoSubmissions } from "./videos";

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

export type ObservationCycle = typeof observationCycles.$inferSelect;
export type ObservationForm = typeof observationForms.$inferSelect;
export type ObservationEvidence = typeof observationEvidence.$inferSelect;
