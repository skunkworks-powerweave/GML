import { z } from "zod";
import { assessments, RECORD_APPROVAL_STATES } from "@gml/db/schema";
import type { AdminEntity } from "../types";
import { allRules, classAtTeachersSchool, scaleOfKind } from "../rules";

// A test a teacher sets a class (migration 0043), whose marks are
// assessment-marks. The teacher keeps her own at /teaching/marks and sends
// them for approval; the approval state is shown here and moved only by the
// approvals queue (lib/approvals), never by the grid -- as a cycle's stage is
// moved only by the observation workflow. One entered here starts as a
// draft, which its teacher can fill in and submit.
export const assessmentsEntity: AdminEntity = {
  slug: "assessments",
  table: assessments,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "title" },
    { key: "teacherId" },
    { key: "classId" },
    { key: "section" },
    { key: "subjectId" },
    { key: "term" },
    { key: "maxMarks" },
    { key: "assessedOn" },
    { key: "approvalStatus", choices: RECORD_APPROVAL_STATES },
  ],
  formSchema: z.object({
    teacherId: z.string().uuid(),
    classId: z.string().uuid(),
    subjectId: z.string().uuid(),
    section: z.string().trim().max(8).optional().nullable(),
    term: z.coerce.number().int().min(1).max(6).optional().nullable(),
    title: z.string().trim().min(1).max(200),
    maxMarks: z.coerce.number().int().min(1).max(1000),
    // A DATE column: ISO only, as sessions.scheduledDate (admin/dates.ts).
    assessedOn: z.string().trim().date("validation.isoDate").optional().nullable(),
    gradingScaleId: z.string().uuid().optional().nullable(),
  }),
  formFields: ["teacherId", "classId", "subjectId", "section", "term", "title", "maxMarks", "assessedOn", "gradingScaleId"],
  writeStamp: ({ op }) => (op === "update" ? { updatedAt: new Date() } : {}),
  validate: allRules(classAtTeachersSchool(), scaleOfKind("gradingScaleId", "student")),
  describeRow: (r) => `assessment:${r.title ?? r.id}`,
};
