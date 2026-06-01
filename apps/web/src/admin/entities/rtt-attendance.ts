import { z } from "zod";
import { rttAttendance } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT-content attendance (training cohort attendance per RTT session × teacher).
// v2 rename of v1's `attendance` → `rtt_attendance` (spec 013).
// Distinct from classroom-session attendance which lives ON the `sessions` table
// (spec 017) as `attended_count` / `total_count`.
export const rttAttendanceEntity: AdminEntity = {
  slug: "rtt-attendance",
  label: "RTT Attendance",
  table: rttAttendance,
  readRoles: ["programme_admin", "super_admin", "mentor"],
  mutateRoles: ["super_admin"], // v2 conservative cut: programme_admin has no attendance write
  displayColumns: [
    { key: "rttSessionId", label: "Session" },
    { key: "teacherId", label: "Teacher" },
    { key: "status", label: "Status" },
    { key: "markedAt", label: "Marked" },
  ],
  formSchema: z.object({
    rttSessionId: z.string().uuid(),
    teacherId: z.string().uuid(),
    status: z.enum(["present", "absent", "excused"]).default("absent"),
  }),
  formFields: ["rttSessionId", "teacherId", "status"],
  describeRow: (r) => `rtt-attendance:${r.rttSessionId}/${r.teacherId}`,
};
