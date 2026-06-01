import { z } from "zod";
import { sessions } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const sessionsEntity: AdminEntity = {
  slug: "sessions",
  label: "Classroom sessions",
  table: sessions,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["teacher", "programme_admin", "super_admin"],
  displayColumns: [
    { key: "scheduledDate", label: "Date" },
    { key: "schoolId", label: "School" },
    { key: "classId", label: "Class" },
    { key: "subjectId", label: "Subject" },
    { key: "teacherId", label: "Teacher" },
    { key: "topic", label: "Topic" },
    { key: "status", label: "Status" },
    { key: "attendedCount", label: "Present" },
    { key: "totalCount", label: "Roll" },
    { key: "observed", label: "Observed" },
  ],
  formSchema: z.object({
    schoolId: z.string().uuid(),
    classId: z.string().uuid(),
    subjectId: z.string().uuid(),
    teacherId: z.string().uuid(),
    outlineLessonId: z.string().uuid().optional().nullable(),
    scheduledDate: z.string(),
    scheduledTime: z.string().optional().nullable(),
    durationMin: z.coerce.number().int().min(1).optional().nullable(),
    topic: z.string().max(240).optional().nullable(),
    status: z.enum(["planned", "in_progress", "complete", "cancelled"]).default("planned"),
    attendedCount: z.coerce.number().int().min(0).default(0),
    totalCount: z.coerce.number().int().min(0).default(0),
    observed: z.boolean().default(false),
    observationCycleId: z.string().uuid().optional().nullable(),
  }).refine((v) => v.attendedCount <= v.totalCount, { message: "attended_count must not exceed total_count", path: ["attendedCount"] }),
  formFields: ["schoolId", "classId", "subjectId", "teacherId", "outlineLessonId", "scheduledDate", "scheduledTime", "durationMin", "topic", "status", "attendedCount", "totalCount", "observed", "observationCycleId"],
  describeRow: (r) => `session:${r.scheduledDate}/${r.classId}`,
};
