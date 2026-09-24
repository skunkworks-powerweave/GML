import { z } from "zod";
import { phases } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT phases -- the top of the training hierarchy (phase > term > subject).
//
// WHY THIS ENTITY EXISTS. The only INSERT into `phases` in the repository was
// the seed, which creates Phase 1-3 with hardcoded dates; Phase 3 ends on
// 2026-09-30. The dashboard names "the current phase" from these dates, so
// after that day it names none, and there was no screen that could open Phase
// 4, correct a date, or give teachers.currentPhaseId anything past Phase 3.
// Same defect class, and the same fix, as entities/rtt-sessions.ts.
//
// Deleting a phase that still has terms is refused (terms.phase_id is ON
// DELETE RESTRICT since migration 0029).
//
// Test: tests/behaviour/admin-rtt-structure.test.ts.
export const phasesEntity: AdminEntity = {
  slug: "phases",
  label: "RTT Phases",
  table: phases,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "label", label: "Phase" },
    { key: "sequence", label: "Seq" },
    { key: "startDate", label: "Starts" },
    { key: "endDate", label: "Ends" },
  ],
  formSchema: z
    .object({
      // NOT NULL UNIQUE varchar(24): "Phase 4".
      label: z.string().trim().min(1).max(24),
      // The dashboard and /repo/teachers order phases by it; unique since 0030.
      sequence: z.coerce.number().int().min(1).max(999),
      // Nullable in the table: a phase can be planned before it is dated. An
      // undated phase is simply never "current".
      startDate: z.coerce.date().optional().nullable(),
      endDate: z.coerce.date().optional().nullable(),
    })
    // Also a CHECK in the database (0030); here so the form says which field.
    .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
      message: "A phase cannot end before it starts",
      path: ["endDate"],
    }),
  formFields: ["label", "sequence", "startDate", "endDate"],
  describeRow: (r) => `phase:${r.label ?? r.id}`,
};
