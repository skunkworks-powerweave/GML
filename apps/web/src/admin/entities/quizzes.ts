import { z } from "zod";
import { quizzes } from "@gml/db/schema";
import type { AdminEntity, AdminMessage } from "../types";
import { allRules, quizActiveHasQuestions, scaleOfKind } from "../rules";

// Quizzes' settings as a data table, for the one setting nothing else could
// set: the grade scale a result is graded on (quizzes.grading_scale_id,
// migration 0043; NULL = the default quiz scale). The questions are edited at
// /admin/quizzes/[id], and a quiz created here starts inactive, as one
// created there does.
//
// NEVER DELETED FROM HERE. Deleting a quiz deletes its questions and every
// learner's attempts and results (their foreign keys cascade); a quiz is
// withdrawn by setting it inactive, which keeps them. The guard refuses the
// delete and says so.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function neverDeleted(op: "update" | "delete"): AdminMessage | null {
  return op === "delete" ? { key: "guard.quizUndeletable" } : null;
}

export const quizzesEntity: AdminEntity = {
  slug: "quizzes",
  table: quizzes,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "title" },
    { key: "slug" },
    { key: "rttSubjectId" },
    { key: "subjectId" },
    { key: "passThreshold" },
    { key: "gradingScaleId" },
    { key: "active" },
  ],
  formSchema: z
    .object({
      title: z.string().trim().min(2).max(200),
      // The quiz's address, /quizzes/<slug>.
      slug: z.string().trim().toLowerCase().max(60).regex(SLUG_RE, "validation.quizSlug"),
      rttSubjectId: z.string().uuid().optional().nullable(),
      subjectId: z.string().uuid().optional().nullable(),
      passThreshold: z.coerce.number().int().min(0).max(100).default(60),
      gradingScaleId: z.string().uuid().optional().nullable(),
      timeLimitSeconds: z.coerce.number().int().min(60).max(7200).optional().nullable(),
      maxAttempts: z.coerce.number().int().min(1).max(20).optional().nullable(),
      active: z.boolean().default(false),
    })
    // quizzes_one_scope: an RTT subject or a school subject, not both, not neither.
    .refine((v) => Boolean(v.rttSubjectId) !== Boolean(v.subjectId), {
      message: "validation.quizScope",
      path: ["rttSubjectId"],
    }),
  formFields: [
    "title",
    "slug",
    "rttSubjectId",
    "subjectId",
    "passThreshold",
    "gradingScaleId",
    "timeLimitSeconds",
    "maxAttempts",
    "active",
  ],
  writeStamp: ({ op }) => (op === "update" ? { updatedAt: new Date() } : {}),
  validate: allRules(scaleOfKind("gradingScaleId", "quiz"), quizActiveHasQuestions),
  guardMutation: (op) => neverDeleted(op),
  describeRow: (r) => `quiz:${r.slug ?? r.id}`,
};
