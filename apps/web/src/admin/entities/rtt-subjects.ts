import { z } from "zod";
import { rttSubjects } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT-content subjects (training units bound to a term inside a phase).
// v2 rename of v1's `subjects` → `rtt_subjects` (spec 013).
// Distinct from the curriculum-side `subjects` table that ships in spec 014.
export const rttSubjectsEntity: AdminEntity = {
  slug: "rtt-subjects",
  label: "RTT Subjects",
  table: rttSubjects,
  readRoles: ["programme_admin", "super_admin", "mentor", "observer"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "code", label: "Code" },
    { key: "termId", label: "Term" },
    { key: "districtId", label: "District" },
    { key: "zoneId", label: "Zone" },
    { key: "active", label: "Active" },
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
      message: "Choose a district or a zone, not both: a zone is already in its district.",
    }),
  formFields: ["name", "code", "termId", "districtId", "zoneId", "active"],
  fields: {
    districtId: { help: "Leave district and zone empty for a subject taught across the whole programme." },
    zoneId: { help: "Or one zone only. Teachers see the subjects of their own district and zone." },
  },
  describeRow: (r) => `rtt-subject:${r.name ?? r.id}`,
};
