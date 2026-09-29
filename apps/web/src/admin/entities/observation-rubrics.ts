import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { observationRubrics } from "@gml/db/schema";
import type { AdminDb, AdminEntity, AdminMessage } from "../types";
import { allRules, scaleOfKind } from "../rules";

// Scored observation rubrics (migration 0043): the criteria an observer scores
// on the observer form (rubric-criteria), and the scale the cycle's total is
// graded on (an observation scale; NULL = the default one). The free-text
// rubric of older cycles is untouched.

/** One default rubric (observation_rubrics_one_default_uq), named when refused. */
async function oneDefault(
  db: AdminDb,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<Record<string, AdminMessage> | null> {
  if (row.isDefault !== true) return null;
  const [other] = await db
    .select({ name: observationRubrics.name })
    .from(observationRubrics)
    .where(
      and(
        eq(observationRubrics.isDefault, true),
        typeof before?.id === "string" ? ne(observationRubrics.id, before.id) : undefined,
      ),
    )
    .limit(1);
  return other ? { isDefault: { key: "validation.oneDefaultRubric", values: { name: other.name } } } : null;
}

export const observationRubricsEntity: AdminEntity = {
  slug: "observation-rubrics",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "observation_rubrics",
  table: observationRubrics,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [{ key: "name" }, { key: "gradingScaleId" }, { key: "isDefault" }, { key: "active" }],
  formSchema: z.object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4000).optional().nullable(),
    gradingScaleId: z.string().uuid().optional().nullable(),
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "description", "gradingScaleId", "isDefault", "active"],
  writeStamp: ({ op }) => (op === "update" ? { updatedAt: new Date() } : {}),
  validate: allRules(scaleOfKind("gradingScaleId", "observation"), oneDefault),
  describeRow: (r) => `rubric:${r.name ?? r.id}`,
};
