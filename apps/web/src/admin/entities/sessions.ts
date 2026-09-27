import { z } from "zod";
import { sessions } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const sessionsEntity: AdminEntity = {
  slug: "sessions",
  table: sessions,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  // "teacher" removed. PLAN.md's permission matrix has /admin/data/sessions as
  // admin-write only, and with rank-based role checks this list admitted EVERY
  // authenticated user (teacher was the lowest rank, so it set the floor) --
  // including via POST /api/admin/data/sessions/import, which bulk-inserts.
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "scheduledDate" },
    { key: "schoolId" },
    { key: "classId" },
    { key: "subjectId" },
    { key: "teacherId" },
    { key: "topic" },
    { key: "status" },
    { key: "attendedCount" },
    { key: "totalCount" },
    { key: "observed" },
  ],
  formSchema: z.object({
    schoolId: z.string().uuid(),
    classId: z.string().uuid(),
    subjectId: z.string().uuid(),
    teacherId: z.string().uuid(),
    outlineLessonId: z.string().uuid().optional().nullable(),
    // A DATE column. z.string() alone passed a CSV cell like 05/10/2026
    // straight to Postgres, whose DateStyle (ISO, MDY) stored it as 10 May:
    // the DD/MM ambiguity admin/dates.ts refuses for every other date. The
    // grid's date picker submits exactly this form.
    scheduledDate: z.string().trim().date("validation.isoDate"),
    scheduledTime: z.string().optional().nullable(),
    durationMin: z.coerce.number().int().min(1).optional().nullable(),
    topic: z.string().max(240).optional().nullable(),
    status: z.enum(["planned", "in_progress", "complete", "cancelled"]).default("planned"),
    attendedCount: z.coerce.number().int().min(0).default(0),
    totalCount: z.coerce.number().int().min(0).default(0),
    observed: z.boolean().default(false),
    observationCycleId: z.string().uuid().optional().nullable(),
  }).refine((v) => v.attendedCount <= v.totalCount, { message: "validation.attendedWithinTotal", path: ["attendedCount"] }),
  formFields: ["schoolId", "classId", "subjectId", "teacherId", "outlineLessonId", "scheduledDate", "scheduledTime", "durationMin", "topic", "status", "attendedCount", "totalCount", "observed", "observationCycleId"],
  describeRow: (r) => `session:${r.scheduledDate}/${r.classId}`,
};
