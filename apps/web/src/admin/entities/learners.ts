import { z } from "zod";
import { learners } from "@gml/db/schema";
import { learnerFitsClass, learnerPlacementFromClass } from "../rules";
import type { AdminEntity } from "../types";

// Learners — actual children whom teachers teach. **PII-gated under SM-9.**
// Generic admin grid will call recordAudit('learners.view') on every read.
//
// Programme admins add, edit and delete students (the product owner's
// decision, 2026-09-28: "Programme admins can also write attendance and
// students in the data tables"); until then only super_admin could, and the
// grid offered programme_admin controls that led to /forbidden. Bulk export
// (spec 022) still requires super_admin and emits `learners.bulk_export`:
// a whole-table download of children's details is a different act from
// keeping a class list up to date. Deleting a student also deletes her
// attendance and test marks (their foreign keys cascade), and the delete's
// confirmation says so (admin/delete-effects.ts).
//
// A student's school and grade are her class's: left blank they are filled from
// it, and one that differs is refused, in the grid and in a CSV alike
// (lib/learner-placement.ts; a trigger on learners holds it for any other writer).
export const learnersEntity: AdminEntity = {
  slug: "learners",
  table: learners,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  piiAudited: true,
  displayColumns: [
    { key: "name" },
    { key: "classId" },
    { key: "schoolId" },
    { key: "grade" },
    { key: "section" },
    { key: "rollNumber" },
    { key: "age" },
    { key: "guardian" },
    { key: "attendancePct" },
    { key: "active" },
  ],
  formSchema: z.object({
    classId: z.string().uuid(),
    // Blank is the class's school and grade (fillIn); one that differs from it
    // is refused (validate). lib/learner-placement.ts.
    schoolId: z.string().uuid().optional(),
    grade: z.coerce.number().int().min(1).max(12).optional(),
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
  fillIn: learnerPlacementFromClass,
  validate: learnerFitsClass,
  writeStamp: ({ op }) => (op === "update" ? { updatedAt: new Date() } : {}),
  describeRow: (r) => `learner:${r.name ?? r.id}`,
};
