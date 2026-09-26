import { z } from "zod";
import { mentorPairings, pairingStatusEnum } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const mentorPairingsEntity: AdminEntity = {
  slug: "mentor-pairings",
  label: "Mentor ↔ Mentee Pairings",
  table: mentorPairings,
  readRoles: ["programme_admin", "super_admin", "mentor"],
  mutateRoles: ["programme_admin", "super_admin"],
  // The roster /mentorship and /repo/mentor/[id] keep behind the mentorship
  // password ("it names mentees"); the grid and its CSV export are gated the
  // same way. Test: tests/behaviour/admin-section-gate.test.ts.
  gate: "mentorship",
  displayColumns: [
    { key: "mentorId", label: "Mentor" },
    { key: "teacherId", label: "Mentee teacher" },
    { key: "startedAt", label: "Started" },
    { key: "endedAt", label: "Ended" },
    { key: "status", label: "Status" },
  ],
  formSchema: z.object({
    mentorId: z.string().uuid(),
    teacherId: z.string().uuid(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().optional().nullable(),
    // The database's own list. A hand-written ["active", "paused", "ended"]
    // left out "review" and "complete" (the seed writes both, the one-click
    // Complete pairing the second): the edit form showed such a pairing as
    // "active", so saving a note reopened a finished mentorship, and CSV
    // import and the Status filter refused both values.
    // Test: tests/behaviour/admin-grid-enums.test.ts.
    status: z.enum(pairingStatusEnum.enumValues).default("active"),
    conceptNote: z.string().max(5000).optional().nullable(),
  }),
  formFields: ["mentorId", "teacherId", "startedAt", "endedAt", "status", "conceptNote"],
  describeRow: (r) => `pairing:${r.mentorId}↔${r.teacherId}`,
};
