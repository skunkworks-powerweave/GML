import { z } from "zod";
import { subjects } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const subjectsEntity: AdminEntity = {
  slug: "subjects",
  label: "Subjects",
  table: subjects,
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
  describeRow: (r) => `subject:${r.name ?? r.id}`,
};
