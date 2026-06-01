import { z } from "zod";
import { mentors } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const mentorsEntity: AdminEntity = {
  slug: "mentors",
  label: "Mentors",
  table: mentors,
  readRoles: ["programme_admin", "super_admin", "mentor"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "bio", label: "Bio" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(160),
    bio: z.string().max(2000).optional().nullable(),
    photoUrl: z.string().url().optional().nullable(),
    expertiseAreas: z.array(z.string()).default([]),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "bio", "photoUrl", "expertiseAreas", "active"],
  describeRow: (r) => `mentor:${r.name ?? r.id}`,
};
