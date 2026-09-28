// Teaching records a teacher keeps herself, and the approvals they go through.
//
//   teacher_classes     which classes (and sections) a teacher teaches: "my
//                       classes" and, through learners, "my students"
//   session_attendance  one row per student per session, marked by the teacher
//   assessments /       a test she sets and each student's marks; the grade
//   assessment_marks    comes from a grading scale (./grading.ts)
//   approvals           one queue for everything that needs a programme admin
//                       (or, for teach-backs, a mentor or observer) to approve
//   account_requests    "Request an account" from the login page
//
// Design: docs/superpowers/specs/2026-09-28-teaching-records-design.md.

import { boolean, check, date, index, integer, numeric, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { attendanceStatusEnum } from "./enums";
import { schools, teachers } from "./geography";
import { users } from "./identity";
import { classes } from "./classes";
import { subjects } from "./subjects";
import { learners } from "./learners";
import { sessions } from "./sessions";
import { gradingScales } from "./grading";

/** The approval state a teacher-entered record carries. */
export const RECORD_APPROVAL_STATES = ["draft", "pending", "approved", "changes_requested", "rejected"] as const;
export type RecordApprovalState = (typeof RECORD_APPROVAL_STATES)[number];

export const teacherClasses = pgTable(
  "teacher_classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "cascade" }),
    classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "cascade" }),
    // NULL = the whole grade; otherwise the section she teaches ("A").
    section: varchar("section", { length: 8 }),
    // What she teaches that class, if one subject.
    subjectId: uuid("subject_id").references(() => subjects.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("teacher_classes_teacher_class_section_uq").on(t.teacherId, t.classId, t.section).nullsNotDistinct(),
    index("teacher_classes_class_idx").on(t.classId),
  ],
);

export const sessionAttendance = pgTable(
  "session_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    learnerId: uuid("learner_id").notNull().references(() => learners.id, { onDelete: "cascade" }),
    status: attendanceStatusEnum("status").notNull().default("present"),
    markedByUserId: uuid("marked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    markedAt: timestamp("marked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("session_attendance_session_learner_uq").on(t.sessionId, t.learnerId),
    index("session_attendance_learner_idx").on(t.learnerId, t.markedAt),
  ],
);

export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),
    classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id, { onDelete: "restrict" }),
    section: varchar("section", { length: 8 }),
    term: smallint("term"),
    title: varchar("title", { length: 200 }).notNull(),
    maxMarks: integer("max_marks").notNull(),
    assessedOn: date("assessed_on"),
    // NULL = the default student scale.
    gradingScaleId: uuid("grading_scale_id").references(() => gradingScales.id, { onDelete: "set null" }),
    approvalStatus: varchar("approval_status", { length: 20 }).notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("assessments_teacher_date_idx").on(t.teacherId, t.assessedOn),
    index("assessments_class_idx").on(t.classId),
    check("assessments_max_marks_check", sql`${t.maxMarks} BETWEEN 1 AND 1000`),
    check("assessments_term_check", sql`${t.term} IS NULL OR ${t.term} BETWEEN 1 AND 6`),
    check("assessments_approval_status_check", sql`${t.approvalStatus} IN ('draft', 'pending', 'approved', 'changes_requested', 'rejected')`),
  ],
);

export const assessmentMarks = pgTable(
  "assessment_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    learnerId: uuid("learner_id").notNull().references(() => learners.id, { onDelete: "cascade" }),
    // NULL with absent = true: the student missed the test.
    marks: numeric("marks", { precision: 6, scale: 2 }),
    absent: boolean("absent").notNull().default(false),
    remark: varchar("remark", { length: 240 }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assessment_marks_assessment_learner_uq").on(t.assessmentId, t.learnerId),
    check("assessment_marks_marks_check", sql`${t.marks} IS NULL OR ${t.marks} >= 0`),
  ],
);

/** Everything that goes through the approvals queue. */
export const APPROVAL_ITEM_TYPES = [
  "lesson_plan",
  "session",
  "assessment",
  "teach_back",
  "observation_signoff",
  "account_request",
] as const;
export type ApprovalItemType = (typeof APPROVAL_ITEM_TYPES)[number];

export const APPROVAL_DECISIONS = ["approved", "changes_requested", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemType: varchar("item_type", { length: 32 }).notNull().$type<ApprovalItemType>(),
    itemId: uuid("item_id").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    // What the submitter wrote when sending it ("Resubmitted with the new dates").
    note: text("note"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    // The approver's reason or feedback; required for changes_requested and rejected.
    comment: text("comment"),
  },
  (t) => [
    index("approvals_queue_idx").on(t.status, t.itemType, t.submittedAt),
    index("approvals_item_idx").on(t.itemType, t.itemId, t.submittedAt),
    // One open request per item at a time.
    uniqueIndex("approvals_one_pending_uq").on(t.itemType, t.itemId).where(sql`${t.status} = 'pending'`),
    check("approvals_status_check", sql`${t.status} IN ('pending', 'approved', 'changes_requested', 'rejected')`),
    check(
      "approvals_item_type_check",
      sql`${t.itemType} IN ('lesson_plan', 'session', 'assessment', 'teach_back', 'observation_signoff', 'account_request')`,
    ),
    check("approvals_decided_check", sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`),
  ],
);

export const accountRequests = pgTable(
  "account_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    email: varchar("email", { length: 254 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    schoolId: uuid("school_id").references(() => schools.id, { onDelete: "set null" }),
    requestedRole: varchar("requested_role", { length: 16 }).notNull().default("teacher"),
    message: text("message"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decisionReason: text("decision_reason"),
    // The login created when the request was approved.
    createdUserId: uuid("created_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("account_requests_status_idx").on(t.status, t.createdAt),
    // One open request per address.
    uniqueIndex("account_requests_one_pending_uq").on(sql`lower(${t.email})`).where(sql`${t.status} = 'pending'`),
    check("account_requests_role_check", sql`${t.requestedRole} IN ('teacher', 'mentor', 'observer')`),
    check("account_requests_status_check", sql`${t.status} IN ('pending', 'approved', 'rejected')`),
  ],
);

export type TeacherClass = typeof teacherClasses.$inferSelect;
export type SessionAttendance = typeof sessionAttendance.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type AssessmentMark = typeof assessmentMarks.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type AccountRequest = typeof accountRequests.$inferSelect;
