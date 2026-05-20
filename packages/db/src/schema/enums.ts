import { pgEnum } from "drizzle-orm/pg-core";

// 5 platform roles. Order matters — least-privilege first.
export const roleEnum = pgEnum("role", [
  "teacher",
  "observer",
  "mentor",
  "programme_admin",
  "super_admin",
]);

// Section gates (rotatable passwords gating major content areas).
export const sectionGateSlugEnum = pgEnum("section_gate_slug", [
  "mentorship",
  "observation",
  "tkt",
  "ttt",
]);

// Audit log action types.
export const auditActionEnum = pgEnum("audit_action", [
  "view",
  "download",
  "upload",
  "edit",
  "delete",
  "gate_pass",
  "gate_fail",
  "login",
  "logout",
]);

// Video pipeline status (used in spec 022+).
export const videoStatusEnum = pgEnum("video_status", [
  "received",
  "queued",
  "transcoding",
  "ready",
  "failed",
  "review_pending",
  "reviewed",
]);

// Video ingestion source.
export const videoSourceEnum = pgEnum("video_source", [
  "direct",
  "whatsapp",
  "external_link",
  "google_drive",
]);

// Observation cycle kind.
export const observationKindEnum = pgEnum("observation_kind", [
  "baseline",
  "developmental",
  "evaluative",
]);

// Observation cycle status.
export const observationStatusEnum = pgEnum("observation_status", [
  "nominated",
  "pre_submitted",
  "observed",
  "post_submitted",
  "complete",
]);

// Mentorship feedback form kinds.
export const feedbackKindEnum = pgEnum("feedback_kind", [
  "baseline",
  "progress_1",
  "progress_2",
  "final",
]);

export const feedbackAudienceEnum = pgEnum("feedback_audience", ["mentor", "mentee"]);

// Mentorship pairing status.
export const pairingStatusEnum = pgEnum("pairing_status", ["active", "paused", "ended"]);

// Attendance.
export const attendanceStatusEnum = pgEnum("attendance_status", [
  "present",
  "absent",
  "excused",
]);
