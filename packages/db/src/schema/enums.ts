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
// v2 (spec 021): `admin` added to gate the audit log behind a rotatable password
// for super_admin roles per the prototype's `gate: "admin"` on the Audit log nav.
export const sectionGateSlugEnum = pgEnum("section_gate_slug", [
  "mentorship",
  "observation",
  "admin",
  "tkt",
  "ttt",
]);

// AuditAction — v2 (spec 021): NO LONGER an enum. audit_log.action is now varchar(64)
// to support dotted notation (`gate.attempt.fail`, `whatsapp.media.fetched`,
// `transcode.success`, etc) used throughout the prototype's AUDIT seed.
// Convention enforced by `recordAudit` callers + CI grep gate (spec 011's SM-1 test
// asserts no UPDATE/DELETE on audit_log; the convention itself is documented in
// docs/audit-actions.md). The TypeScript-side AuditAction type is a free-form
// `string` in this file (exported from audit.ts as `AuditAction = string`).

// Video pipeline status (used in spec 036+).
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
// v2 (spec 021): `review` and `complete` added per prototype seed data
// (p04 status="review", p09 status="complete").
export const pairingStatusEnum = pgEnum("pairing_status", [
  "active",
  "review",
  "paused",
  "ended",
  "complete",
]);

// Attendance.
export const attendanceStatusEnum = pgEnum("attendance_status", [
  "present",
  "absent",
  "excused",
]);
