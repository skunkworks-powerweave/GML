import { z } from "zod";
import { resources } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const resourcesEntity: AdminEntity = {
  slug: "resources",
  table: resources,
  readRoles: ["teacher", "observer", "mentor", "programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name" },
    { key: "kind" },
    { key: "owner" },
    { key: "pages" },
    { key: "active" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(240),
    kind: z.enum(["Policy","Guide","Handbook","Worksheet","Template","Routine","Calendar","Checklist","Lab-guide","Rubric","Other"]),
    owner: z.string().max(120).optional().nullable(),
    pages: z.coerce.number().int().min(1).optional().nullable(),
    fileKey: z.string().optional().nullable(),
    externalUrl: z.string().url().optional().nullable(),
    tags: z.array(z.string()).default([]),
    active: z.boolean().default(true),
  }).refine((v) => Boolean(v.fileKey) || Boolean(v.externalUrl), {
    message: "validation.resourceSource",
    path: ["fileKey"],
  }),
  formFields: ["name", "kind", "owner", "pages", "fileKey", "externalUrl", "tags", "active"],
  describeRow: (r) => `resource:${r.name ?? r.id}`,
};
