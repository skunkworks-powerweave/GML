// Mentorship — mentors, mentor↔mentee pairings, meetings, feedback forms/responses.

import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { feedbackAudienceEnum, feedbackKindEnum, pairingStatusEnum } from "./enums";
import { teachers } from "./geography";
import { users } from "./identity";

export const mentors = pgTable(
  "mentors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: varchar("name", { length: 160 }).notNull(),
    hindiName: varchar("hindi_name", { length: 160 }), // v2 (spec 020) — SM-7: always NULLABLE
    baseLocation: varchar("base_location", { length: 80 }), // v2 (spec 020) — "Leh" / "Kargil"
    bio: text("bio"),
    expertiseAreas: jsonb("expertise_areas").$type<string[]>().default([]),
    photoUrl: text("photo_url"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);

export const mentorPairings = pgTable(
  "mentor_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mentorId: uuid("mentor_id").notNull().references(() => mentors.id, { onDelete: "restrict" }),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    status: pairingStatusEnum("status").notNull().default("active"),
    conceptNote: text("concept_note"),
    // v2 (spec 020): quarter strip + cached counters
    currentQuarter: smallint("current_quarter"),
    meetingsCount: integer("meetings_count").notNull().default(0),
    lastMeetingAt: timestamp("last_meeting_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("mentor_pairings_mentor_teacher_started_uq").on(t.mentorId, t.teacherId, t.startedAt),
    index("mentor_pairings_status_idx").on(t.status),
    check("mentor_pairings_quarter_check", sql`${t.currentQuarter} IS NULL OR (${t.currentQuarter} BETWEEN 1 AND 4)`),
    check("mentor_pairings_meetings_count_check", sql`${t.meetingsCount} >= 0`),
  ],
);

export const mentorMeetings = pgTable(
  "mentor_meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pairingId: uuid("pairing_id").notNull().references(() => mentorPairings.id, { onDelete: "cascade" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }).notNull(),
    durationMin: text("duration_min"),
    notes: text("notes"),
    recordingVideoId: uuid("recording_video_id"), // FK to video_submissions (spec 022)
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("mentor_meetings_pairing_idx").on(t.pairingId, t.scheduledAt)],
);

export const feedbackForms = pgTable(
  "feedback_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: feedbackKindEnum("kind").notNull(),
    audience: feedbackAudienceEnum("audience").notNull(),
    schema: jsonb("schema").$type<unknown>().notNull(),
    version: text("version").notNull().default("1"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("feedback_forms_kind_audience_version_uq").on(t.kind, t.audience, t.version)],
);

export const feedbackResponses = pgTable(
  "feedback_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formId: uuid("form_id").notNull().references(() => feedbackForms.id, { onDelete: "restrict" }),
    pairingId: uuid("pairing_id").notNull().references(() => mentorPairings.id, { onDelete: "cascade" }),
    respondentUserId: uuid("respondent_user_id").references(() => users.id, { onDelete: "set null" }),
    responses: jsonb("responses").$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("feedback_responses_pairing_idx").on(t.pairingId)],
);

export type Mentor = typeof mentors.$inferSelect;
export type MentorPairing = typeof mentorPairings.$inferSelect;
export type MentorMeeting = typeof mentorMeetings.$inferSelect;
export type FeedbackForm = typeof feedbackForms.$inferSelect;
export type FeedbackResponse = typeof feedbackResponses.$inferSelect;
