import { z } from "zod";
import { rubricCriteria } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// One criterion of a scored rubric: its place, its title, what each level
// looks like, and the highest score (1..10). A criterion that has been scored
// cannot be deleted (observation_scores refuses it), so a used rubric keeps
// the criteria its cycles were scored on.
export const rubricCriteriaEntity: AdminEntity = {
  slug: "rubric-criteria",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "rubric_criteria",
  table: rubricCriteria,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [{ key: "rubricId" }, { key: "sequence" }, { key: "title" }, { key: "maxScore" }],
  formSchema: z.object({
    rubricId: z.string().uuid(),
    sequence: z.coerce.number().int().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional().nullable(),
    maxScore: z.coerce.number().int().min(1).max(10).default(4),
  }),
  formFields: ["rubricId", "sequence", "title", "description", "maxScore"],
  describeRow: (r) => `criterion:${r.rubricId}/#${r.sequence}`,
};
