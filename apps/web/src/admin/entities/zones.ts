import { z } from "zod";
import { zones } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const zonesEntity: AdminEntity = {
  slug: "zones",
  label: "Zones",
  table: zones,
  readRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Zone" },
    { key: "districtId", label: "District" },
    { key: "createdAt", label: "Created" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(80),
    districtId: z.string().uuid(),
  }),
  formFields: ["name", "districtId"],
  describeRow: (r) => `zone:${r.name ?? r.id}`,
};
