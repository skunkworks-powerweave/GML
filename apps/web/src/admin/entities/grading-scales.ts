import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { gradingScales, GRADING_TARGETS } from "@gml/db/schema";
import type { AdminDb, AdminEntity, AdminMessage } from "../types";

// Grade scales (migration 0043): what a percentage is called -- A1 91-100 ...
// E 0-32 -- for students' test marks, quiz results or observation rubric
// totals. Its bands are the grading-bands entity; /admin/grading is the
// friendlier editor for both. Design:
// docs/superpowers/specs/2026-09-28-teaching-records-design.md.

/**
 * One default scale per kind (grading_scales_one_default_uq). The index
 * refuses a second one, but as "a duplicate value" with no field; this says
 * which scale already is the default, so the operator knows what to change.
 */
async function oneDefault(
  db: AdminDb,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
): Promise<Record<string, AdminMessage> | null> {
  if (row.isDefault !== true || typeof row.appliesTo !== "string") return null;
  const others = await db
    .select({ name: gradingScales.name })
    .from(gradingScales)
    .where(
      and(
        eq(gradingScales.appliesTo, row.appliesTo as (typeof GRADING_TARGETS)[number]),
        eq(gradingScales.isDefault, true),
        typeof before?.id === "string" ? ne(gradingScales.id, before.id) : undefined,
      ),
    )
    .limit(1);
  return others[0] ? { isDefault: { key: "validation.oneDefaultScale", values: { name: others[0].name } } } : null;
}

export const gradingScalesEntity: AdminEntity = {
  slug: "grading-scales",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "grading_scales",
  table: gradingScales,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [{ key: "name" }, { key: "appliesTo" }, { key: "isDefault" }, { key: "active" }, { key: "description" }],
  formSchema: z.object({
    name: z.string().trim().min(1).max(120),
    appliesTo: z.enum(GRADING_TARGETS),
    description: z.string().max(4000).optional().nullable(),
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "appliesTo", "description", "isDefault", "active"],
  writeStamp: ({ op }) => (op === "update" ? { updatedAt: new Date() } : {}),
  validate: oneDefault,
  describeRow: (r) => `grading-scale:${r.name ?? r.id}`,
};
