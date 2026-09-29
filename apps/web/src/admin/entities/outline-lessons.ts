import { z } from "zod";
import { outlineLessons } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const outlineLessonsEntity: AdminEntity = {
  slug: "outline-lessons",
  table: outlineLessons,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "outlineId" },
    { key: "sequence" },
    { key: "title" },
    { key: "week" },
  ],
  formSchema: z.object({
    outlineId: z.string().uuid(),
    sequence: z.coerce.number().int().min(1),
    title: z.string().min(2).max(240),
    week: z.coerce.number().int().min(1).optional().nullable(),
    // Migration 0043: the lesson plan itself.
    objectives: z.string().max(8000).optional().nullable(),
    activities: z.string().max(8000).optional().nullable(),
    materials: z.string().max(8000).optional().nullable(),
  }),
  formFields: ["outlineId", "sequence", "title", "week", "objectives", "activities", "materials"],
  describeRow: (r) => `outline-lesson:${r.outlineId}/#${r.sequence}`,
};
