import { z } from "zod";
import { attendanceStatusEnum, rttAttendance } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT-content attendance (training cohort attendance per RTT session × teacher).
// v2 rename of v1's `attendance` → `rtt_attendance` (spec 013).
// Distinct from classroom-session attendance (session_attendance, one row per
// learner per classroom session, migration 0043).
//
// Programme admins take this attendance on /attendance (lib/rtt/attendance.ts),
// and may correct and import it here too: the design has them write
// attendance in the data tables (docs/superpowers/specs/2026-09-28-teaching-
// records-design.md). The status choices are the enum's own, "late" included
// (migration 0043), so a stored value is never missing from the form.
export const rttAttendanceEntity: AdminEntity = {
  slug: "rtt-attendance",
  table: rttAttendance,
  readRoles: ["programme_admin", "super_admin", "mentor"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "rttSessionId" },
    { key: "teacherId" },
    { key: "status" },
    { key: "markedAt" },
  ],
  formSchema: z.object({
    rttSessionId: z.string().uuid(),
    teacherId: z.string().uuid(),
    status: z.enum(attendanceStatusEnum.enumValues).default("absent"),
  }),
  formFields: ["rttSessionId", "teacherId", "status"],
  // A mark typed into the grid says who took it and when, as one taken on
  // /attendance does.
  writeStamp: ({ userId }) => ({ markedByUserId: userId, markedAt: new Date() }),
  describeRow: (r) => `rtt-attendance:${r.rttSessionId}/${r.teacherId}`,
};
