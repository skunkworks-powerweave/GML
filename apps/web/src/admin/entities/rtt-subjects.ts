import { z } from "zod";
import { rttSubjects } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT-content subjects (training units bound to a term inside a phase).
// v2 rename of v1's `subjects` → `rtt_subjects` (spec 013).
// Distinct from the curriculum-side `subjects` table that ships in spec 014.
export const rttSubjectsEntity: AdminEntity = {
  slug: "rtt-subjects",
  table: rttSubjects,
  readRoles: ["programme_admin", "super_admin", "mentor", "observer"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name" },
    { key: "code" },
    { key: "termId" },
    { key: "districtId" },
    { key: "zoneId" },
    { key: "active" },
  ],
  // WHERE the subject is taught (migration 0038; lib/rtt/scope.ts): neither
  // for the whole programme, a district for all its zones, or one zone. Not
  // both -- a zone already names its district, and rtt_subjects_one_place
  // would refuse the pair; saying so here names the field.
  formSchema: z
    .object({
      name: z.string().min(2).max(160),
      code: z.string().max(32).optional().nullable(),
      termId: z.string().uuid(),
      districtId: z.string().uuid().optional().nullable(),
      zoneId: z.string().uuid().optional().nullable(),
      active: z.boolean().default(true),
    })
    .refine((v) => !(v.districtId && v.zoneId), {
      path: ["zoneId"],
      message: "validation.districtOrZone",
    }),
  // The district and zone inputs carry a line of guidance each:
  // adminData.entities.rtt-subjects.help (admin/labels.ts).
  formFields: ["name", "code", "termId", "districtId", "zoneId", "active"],
  describeRow: (r) => `rtt-subject:${r.name ?? r.id}`,
};
