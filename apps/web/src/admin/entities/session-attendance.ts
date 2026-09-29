import { z } from "zod";
import { sessionAttendance } from "@gml/db/schema";
import type { AdminEntity } from "../types";
import { learnerOfRecordClass } from "../rules";

// A student's attendance at one classroom session (migration 0043), one row
// per student per session. Teachers mark their own sessions at
// /teaching/sessions/[id]; programme admins can write it here too (the design:
// "Programme admins can also write attendance and students in the data
// tables"). Who marked it and when are the server's to set (writeStamp), not
// the form's.
//
// It names a child (the learner picker and cells show her name), so every
// read of the grid is audited like the learners grid (SM-9), as
// `session_attendance.view` -- the slug has a hyphen, which an audit action
// may not (docs/audit-actions.md).
export const sessionAttendanceEntity: AdminEntity = {
  slug: "session-attendance",
  table: sessionAttendance,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  piiAudited: true,
  auditName: "session_attendance",
  displayColumns: [
    { key: "sessionId" },
    { key: "learnerId" },
    { key: "status" },
    { key: "markedByUserId" },
    { key: "markedAt" },
  ],
  formSchema: z.object({
    sessionId: z.string().uuid(),
    learnerId: z.string().uuid(),
    // attendance_status, in the database enum's own order (admin-grid-enums).
    status: z.enum(["present", "absent", "excused", "late"]).default("present"),
  }),
  formFields: ["sessionId", "learnerId", "status"],
  writeStamp: ({ userId }) => ({ markedByUserId: userId, markedAt: new Date() }),
  validate: learnerOfRecordClass("sessionId"),
  // A class list re-uploaded: one mark per student per session.
  duplicateKey: ["sessionId", "learnerId"],
  describeRow: (r) => `attendance:${r.sessionId}/${r.learnerId}`,
};
