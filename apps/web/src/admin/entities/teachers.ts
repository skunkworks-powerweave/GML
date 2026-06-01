import { z } from "zod";
import { teachers } from "@gml/db/schema";
import type { AdminEntity } from "../types";

export const teachersEntity: AdminEntity = {
  slug: "teachers",
  label: "Teachers",
  table: teachers,
  readRoles: ["programme_admin", "super_admin", "mentor", "observer"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "fullName", label: "Name" },
    { key: "schoolId", label: "School" },
    { key: "phone", label: "Phone" },
    { key: "subjectSpecialism", label: "Subject" },
    { key: "joinedPhase", label: "Phase" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    fullName: z.string().min(2).max(160),
    schoolId: z.string().uuid(),
    phone: z.string().max(32).optional().nullable(),
    subjectSpecialism: z.string().max(80).optional().nullable(),
    joinedPhase: z.string().max(16).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["fullName", "schoolId", "phone", "subjectSpecialism", "joinedPhase", "active"],
  describeRow: (r) => `teacher:${r.fullName ?? r.id}`,
};
