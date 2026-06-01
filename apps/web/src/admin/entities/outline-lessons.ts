import { z } from "zod";
import { outlineLessons } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const outlineLessonsEntity: AdminEntity = {
  slug: "outline-lessons",
  label: "Outline lessons",
  table: outlineLessons,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "outlineId", label: "Outline" },
    { key: "sequence", label: "#" },
    { key: "title", label: "Title" },
    { key: "week", label: "Week" },
  ],
  formSchema: z.object({
    outlineId: z.string().uuid(),
    sequence: z.coerce.number().int().min(1),
    title: z.string().min(2).max(240),
    week: z.coerce.number().int().min(1).optional().nullable(),
  }),
  formFields: ["outlineId", "sequence", "title", "week"],
  describeRow: (r) => `outline-lesson:${r.outlineId}/#${r.sequence}`,
};
