import { z } from "zod";
import { districts } from "@gml/db/schema";
import type { AdminEntity } from "../types";

// Districts -- the top of the geography (district > zone > school).
//
// WHY THIS ENTITY EXISTS. zones require a districtId and the seed's two
// districts (Leh, Kargil) were the only ones any screen could reach. Deleting
// a district that still has zones is refused (zones.district_id is ON DELETE
// RESTRICT since migration 0029) -- and note that seed.ts skips everything once
// ANY district exists, which is what keeps a purged demo from coming back.
//
// Test: tests/behaviour/admin-rtt-structure.test.ts.
export const districtsEntity: AdminEntity = {
  slug: "districts",
  label: "Districts",
  table: districts,
  readRoles: ["programme_admin", "super_admin"],
  mutateRoles: ["programme_admin", "super_admin"],
  displayColumns: [
    { key: "name", label: "District" },
    { key: "code", label: "Code" },
    { key: "createdAt", label: "Created" },
  ],
  formSchema: z.object({
    // Both NOT NULL UNIQUE: varchar(80) and varchar(16).
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().min(1).max(16),
  }),
  formFields: ["name", "code"],
  describeRow: (r) => `district:${r.name ?? r.id}`,
};
