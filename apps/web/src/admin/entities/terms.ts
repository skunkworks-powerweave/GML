import { z } from "zod";
import { terms } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT terms -- the level between a phase and its training subjects.
//
// WHY THIS ENTITY EXISTS. rtt-subjects requires a termId, and the seed's five
// terms were the only ones that could ever exist: Phase 3 has only "Term 1",
// so its second term's subjects had nowhere to hang. See entities/phases.ts.
//
// (phase_id, name) and (phase_id, sequence) are unique in the database, so a
// duplicate comes back from the grid as "conflicts with an existing row".
//
// Test: tests/behaviour/admin-rtt-structure.test.ts.
export const termsEntity: AdminEntity = {
  slug: "terms",
  label: "RTT Terms",
  table: terms,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "phaseId", label: "Phase" },
    { key: "name", label: "Term" },
    { key: "sequence", label: "Seq" },
  ],
  formSchema: z.object({
    phaseId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    sequence: z.coerce.number().int().min(1).max(99),
  }),
  formFields: ["phaseId", "name", "sequence"],
  describeRow: (r) => `term:${r.name ?? r.id}`,
};
