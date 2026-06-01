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
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(160),
    code: z.string().max(32).optional().nullable(),
    termId: z.string().uuid(),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "code", "termId", "active"],
  describeRow: (r) => `rtt-subject:${r.name ?? r.id}`,
};
