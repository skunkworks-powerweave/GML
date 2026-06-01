import { z } from "zod";
import { classes } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const classesEntity: AdminEntity = {
  slug: "classes",
  label: "Classes",
  table: classes,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "schoolId", label: "School" },
    { key: "grade", label: "Grade" },
    { key: "stage", label: "Stage" },
    { key: "studentsCount", label: "Students" },
    { key: "sectionsCount", label: "Sections" },
    { key: "classTeacherName", label: "Class teacher" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    schoolId: z.string().uuid(),
    grade: z.coerce.number().int().min(1).max(12),
    stage: z.string().min(2).max(16),
    studentsCount: z.coerce.number().int().min(0).default(0),
    sectionsCount: z.coerce.number().int().min(1).default(1),
    classTeacherName: z.string().max(160).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["schoolId", "grade", "stage", "studentsCount", "sectionsCount", "classTeacherName", "active"],
  describeRow: (r) => `class:school=${r.schoolId}/grade=${r.grade}`,
};
