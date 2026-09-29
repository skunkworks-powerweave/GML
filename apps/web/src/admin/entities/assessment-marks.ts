import { z } from "zod";
import { assessmentMarks } from "@gml/db/schema";
import type { AdminEntity } from "../types";
import { allRules, learnerOfRecordClass, marksWithinMaximum } from "../rules";

// One student's marks in one test (migration 0043). The grade is not stored:
// it comes from the test's grade scale (lib/grading). A child's marks, named,
// so reads are audited as for the learners grid (SM-9), as
// `assessment_marks.view`.
export const assessmentMarksEntity: AdminEntity = {
  slug: "assessment-marks",
  table: assessmentMarks,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  piiAudited: true,
  auditName: "assessment_marks",
  displayColumns: [{ key: "assessmentId" }, { key: "learnerId" }, { key: "marks" }, { key: "absent" }, { key: "remark" }],
  formSchema: z
    .object({
      assessmentId: z.string().uuid(),
      learnerId: z.string().uuid(),
      // numeric(6,2): two decimal places at most.
      marks: z.coerce.number().min(0).multipleOf(0.01).optional().nullable(),
      absent: z.boolean().default(false),
      remark: z.string().max(240).optional().nullable(),
    })
    // Absent means no marks: the column is NULL for a student who missed it.
    .refine((v) => !(v.absent && v.marks !== null && v.marks !== undefined), {
      message: "validation.absentNoMarks",
      path: ["marks"],
    }),
  formFields: ["assessmentId", "learnerId", "marks", "absent", "remark"],
  writeStamp: () => ({ updatedAt: new Date() }),
  validate: allRules(learnerOfRecordClass("assessmentId"), marksWithinMaximum),
  duplicateKey: ["assessmentId", "learnerId"],
  describeRow: (r) => `marks:${r.assessmentId}/${r.learnerId}`,
};
