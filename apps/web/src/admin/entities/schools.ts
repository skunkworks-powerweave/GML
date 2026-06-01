import { z } from "zod";
import { schools } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const schoolsEntity: AdminEntity = {
  slug: "schools",
  label: "Schools",
  table: schools,
  readRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "Name" },
    { key: "zoneId", label: "Zone" },
    { key: "contactPhone", label: "Phone" },
    { key: "headTeacherName", label: "Head" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    name: z.string().min(2).max(160),
    zoneId: z.string().uuid(),
    address: z.string().max(500).optional().nullable(),
    contactPhone: z.string().max(32).optional().nullable(),
    headTeacherName: z.string().max(160).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "zoneId", "address", "contactPhone", "headTeacherName", "active"],
  describeRow: (r) => `school:${r.name ?? r.id}`,
};
