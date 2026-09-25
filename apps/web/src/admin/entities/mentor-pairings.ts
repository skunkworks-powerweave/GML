import { z } from "zod";
import { mentorPairings } from "@gml/db/schema";
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
    status: z.enum(["active", "paused", "ended"]).default("active"),
    conceptNote: z.string().max(5000).optional().nullable(),
  }),
  formFields: ["mentorId", "teacherId", "startedAt", "endedAt", "status", "conceptNote"],
  describeRow: (r) => `pairing:${r.mentorId}↔${r.teacherId}`,
};
