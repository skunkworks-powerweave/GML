import { z } from "zod";
import { teacherClasses } from "@gml/db/schema";
import type { AdminEntity } from "../types";
import { classAtTeachersSchool } from "../rules";

// Which classes a teacher teaches (migration 0043): a class of her school,
// optionally one section of it ("A"; empty = the whole grade), optionally
// the one subject she teaches it. "My classes" and, through learners, "My
// students" (lib/teaching) come from these rows, so they decide what a
// teacher may see and mark. A teacher adds her own at /teaching/classes.
export const teacherClassesEntity: AdminEntity = {
  slug: "teacher-classes",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "teacher_classes",
  table: teacherClasses,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [{ key: "teacherId" }, { key: "classId" }, { key: "section" }, { key: "subjectId" }],
  formSchema: z.object({
    teacherId: z.string().uuid(),
    classId: z.string().uuid(),
    section: z.string().trim().max(8).optional().nullable(),
    subjectId: z.string().uuid().optional().nullable(),
  }),
  formFields: ["teacherId", "classId", "section", "subjectId"],
  validate: classAtTeachersSchool(),
  describeRow: (r) => `teacher-class:${r.teacherId}/${r.classId}${r.section ? `/${r.section}` : ""}`,
};
