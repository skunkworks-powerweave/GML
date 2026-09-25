import { z } from "zod";
import { learners } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// Learners — actual children whom teachers teach. **PII-gated under SM-9.**
// Generic admin grid will call recordAudit('learners.view') on every read.
// mutateRoles tight to super_admin only; bulk export (spec 022) requires
// super_admin too and emits `learners.bulk_export`.
export const learnersEntity: AdminEntity = {
  slug: "learners",
  label: "Learners (PII)",
  table: learners,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["super_admin"],
  piiAudited: true,
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "classId", label: "Class" },
    { key: "schoolId", label: "School" },
    { key: "grade", label: "Grade" },
    { key: "section", label: "Section" },
    { key: "rollNumber", label: "Roll #" },
    { key: "age", label: "Age" },
    { key: "guardian", label: "Guardian" },
    { key: "attendancePct", label: "Attend %" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    classId: z.string().uuid(),
    schoolId: z.string().uuid(),
    grade: z.coerce.number().int().min(1).max(12),
    name: z.string().min(1).max(160),
    age: z.coerce.number().int().min(3).max(25).optional().nullable(),
    guardian: z.string().max(120).optional().nullable(),
    rollNumber: z.string().max(32).optional().nullable(),
    section: z.string().max(8).optional().nullable(),
    attendancePct: z.coerce.number().int().min(0).max(100).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["classId", "schoolId", "grade", "name", "age", "guardian", "rollNumber", "section", "attendancePct", "active"],
  // A class list re-uploaded after a partial import (csv.ts); the roll number
  // tells two children of one name apart when both rows have it.
  duplicateKey: ["classId", "name", "rollNumber"],
  describeRow: (r) => `learner:${r.name ?? r.id}`,
};
