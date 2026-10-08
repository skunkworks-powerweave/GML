import { z } from "zod";
import { classes } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// studentsCount is shown but not editable: it is the number of active learners in the
// class, kept by a trigger on learners (_post/015). A typed value would be overwritten
// by the next student, so neither the form nor the CSV import takes it.
export const classesEntity: AdminEntity = {
  slug: "classes",
  table: classes,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "schoolId" },
    { key: "grade" },
    { key: "stage" },
    { key: "studentsCount" },
    { key: "sectionsCount" },
    { key: "classTeacherName" },
    { key: "active" },
  ],
  formSchema: z.object({
    schoolId: z.string().uuid(),
    grade: z.coerce.number().int().min(1).max(12),
    stage: z.string().min(2).max(16),
    sectionsCount: z.coerce.number().int().min(1).default(1),
    classTeacherName: z.string().max(160).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["schoolId", "grade", "stage", "sectionsCount", "classTeacherName", "active"],
  describeRow: (r) => `class:school=${r.schoolId}/grade=${r.grade}`,
};
