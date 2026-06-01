// Classroom observation — cycles, forms (pre/post/observer/summary), evidence videos.

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { observationKindEnum, observationStatusEnum } from "./enums";
import { teachers } from "./geography";
import { users } from "./identity";

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
  ],
);

export const observationForms = pgTable(
  "observation_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cycleId: uuid("cycle_id").notNull().references(() => observationCycles.id, { onDelete: "cascade" }),
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
    cycleId: uuid("cycle_id").notNull().references(() => observationCycles.id, { onDelete: "cascade" }),
    videoSubmissionId: uuid("video_submission_id"), // FK to video_submissions in spec 022
    caption: text("caption"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("observation_evidence_cycle_idx").on(t.cycleId)],
);

export type ObservationCycle = typeof observationCycles.$inferSelect;
export type ObservationForm = typeof observationForms.$inferSelect;
export type ObservationEvidence = typeof observationEvidence.$inferSelect;
