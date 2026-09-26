import { z } from "zod";
import { rttReadings } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT required readings — the reading list on an RTT subject page.
//
// WHY THIS ENTITY EXISTS. /rtt/subject/[id] reads rtt_readings on every render
// and nothing wrote it, so "Required readings (0) -- No readings linked." was
// permanent. Same gap, same fix, as entities/rtt-sessions.ts.
//
// WHY `fileKey` IS NOT IN THE FORM. rtt_readings.file_key is a MinIO object key
// (schema/rtt.ts) and MinIO is out of the stack (CLAUDE.md locked decision 4),
// so nothing can serve it. The page's fileKey branch sent the reading's id to
// /repo/resource/[id]/view, which looks it up in `resources` and 404s by
// construction; that branch is gone. A reading is therefore an external link,
// which renders a working "Open" anchor end to end.
//
// Test: tests/behaviour/admin-entities.test.ts.
export const rttReadingsEntity: AdminEntity = {
  slug: "rtt-readings",
  label: "RTT Readings",
  table: rttReadings,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "rttSubjectId", label: "RTT subject" },
    { key: "sequence", label: "Seq" },
    { key: "title", label: "Title" },
    { key: "externalUrl", label: "Link" },
  ],
  formSchema: z.object({
    rttSubjectId: z.string().uuid(),
    sequence: z.coerce.number().int().min(0).max(999),
    title: z.string().trim().min(2).max(240),
    // http(s) only. The value becomes an <a href> on a page every teacher
    // opens, and zod's .url() on its own accepts `javascript:`.
    externalUrl: z
      .string()
      .trim()
      .max(2000)
      .url()
      .regex(/^https?:\/\//i, "Must be an http:// or https:// link"),
  }),
  formFields: ["rttSubjectId", "sequence", "title", "externalUrl"],
  describeRow: (r) => `rtt-reading:${r.title ?? r.id}`,
};
