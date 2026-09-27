import { z } from "zod";
import { zones } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const zonesEntity: AdminEntity = {
  slug: "zones",
  table: zones,
  readRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name" },
    { key: "districtId" },
    { key: "createdAt" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(80),
    districtId: z.string().uuid(),
  }),
  formFields: ["name", "districtId"],
  describeRow: (r) => `zone:${r.name ?? r.id}`,
};
