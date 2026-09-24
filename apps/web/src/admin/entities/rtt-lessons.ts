import { z } from "zod";
import { rttLessons } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// RTT lessons — the steps inside a module.
//
// WHY THIS ENTITY EXISTS. rtt_lessons was in the schema and nothing in the
// application read or wrote it, while /rtt/subject/[id] told teachers to "click
// a module to expand its lessons". The subject page now lists each module's
// lessons (a native <details> disclosure, no client JavaScript), and this is
// the table they are authored in.
//
// `videoId` is left out: it "lands with spec 036" and carries no foreign key
// today, so a free-text box would store ids that point at nothing.
//
// Test: tests/behaviour/admin-entities.test.ts.
export const rttLessonsEntity: AdminEntity = {
  slug: "rtt-lessons",
  label: "RTT Lessons",
  table: rttLessons,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "rttModuleId", label: "RTT module" },
    { key: "sequence", label: "Seq" },
    { key: "title", label: "Title" },
  ],
  formSchema: z.object({
    rttModuleId: z.string().uuid(),
    sequence: z.coerce.number().int().min(1).max(999),
    title: z.string().trim().min(2).max(240),
    // Shown to teachers as plain text (whitespace preserved), never as markup.
    bodyMd: z.string().max(20000).optional().nullable(),
  }),
  formFields: ["rttModuleId", "sequence", "title", "bodyMd"],
  describeRow: (r) => `rtt-lesson:${r.title ?? r.id}`,
};
