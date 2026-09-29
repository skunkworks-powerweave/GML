import { z } from "zod";
import { resources } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// Reading material: a PDF in Storage (the `pdfs` bucket, which
// /api/media/pdf/[id] streams to the watermarked viewer) or a web link.
//
// The PDF is UPLOADED from the form: the file picker sends it to
// /api/admin/data/resources/upload, which checks it is a PDF, stores it and
// fills in the key (fields.fileKey.upload). The key used to be a text box an
// administrator had to paste a Storage object name into -- after putting the
// file there some other way, which nothing in the product offered. A CSV can
// still carry a key, and a web link still works on its own.
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
  fields: {
    fileKey: { upload: "pdf" },
  },
  describeRow: (r) => `resource:${r.name ?? r.id}`,
};
