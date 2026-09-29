import { z } from "zod";
import { gradingBands } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// The bands of a grade scale (migration 0043): a label ("A1") for whole
// percentages min..max inclusive, whether it counts as a pass, and its place
// in the list. lib/grading/bands.ts turns a score into one; overlaps resolve
// to the better grade, so they are allowed here, and /admin/grading lists
// gaps and overlaps. Deleting a scale deletes its bands (the delete warning
// says so; admin/delete-effects.ts).
export const gradingBandsEntity: AdminEntity = {
  slug: "grading-bands",
  // The prefix of its bulk_import / bulk_export audit actions (docs/audit-actions.md).
  auditName: "grading_bands",
  table: gradingBands,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "scaleId" },
    { key: "label" },
    { key: "minPct" },
    { key: "maxPct" },
    { key: "isPass" },
    { key: "sequence" },
  ],
  formSchema: z
    .object({
      scaleId: z.string().uuid(),
      label: z.string().trim().min(1).max(32),
      minPct: z.coerce.number().int().min(0).max(100),
      maxPct: z.coerce.number().int().min(0).max(100),
      isPass: z.boolean().default(true),
      sequence: z.coerce.number().int().min(0).default(0),
      description: z.string().max(200).optional().nullable(),
    })
    // grading_bands_range_check, said as a field error rather than a CHECK
    // violation with no field.
    .refine((v) => v.minPct <= v.maxPct, { message: "validation.bandRange", path: ["maxPct"] }),
  formFields: ["scaleId", "label", "minPct", "maxPct", "isPass", "sequence", "description"],
  describeRow: (r) => `grading-band:${r.label ?? r.id}`,
};
