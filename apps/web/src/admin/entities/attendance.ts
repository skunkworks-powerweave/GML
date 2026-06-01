import { z } from "zod";
import { attendance } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const attendanceEntity: AdminEntity = {
  slug: "attendance",
  label: "Attendance",
  table: attendance,
  readRoles: ["programme_admin", "super_admin", "mentor"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "sessionId", label: "Session" },
    { key: "teacherId", label: "Teacher" },
    { key: "status", label: "Status" },
    { key: "markedAt", label: "Marked" },
  ],
  formSchema: z.object({
    sessionId: z.string().uuid(),
    teacherId: z.string().uuid(),
    status: z.enum(["present", "absent", "excused"]).default("absent"),
  }),
  formFields: ["sessionId", "teacherId", "status"],
  describeRow: (r) => `attendance:${r.sessionId}/${r.teacherId}`,
};
