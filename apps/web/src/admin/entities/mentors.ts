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
    { key: "userId", label: "Login account" },
    { key: "name", label: "Name" },
    { key: "bio", label: "Bio" },
    { key: "active", label: "Active" },
  ],
  formSchema: z.object({
    // LINK TO A LOGIN ACCOUNT. This was not editable anywhere in the product.
    //
    // lib/authz.ts resolves a signed-in teacher through teachers.user_id
    // (teacherIdFor), and that is what cycleVisibilityFilter and
    // assertCanAccessCycle are built on. With the column null -- which it was
    // for all 10 teachers in the live database -- a teacher who logs in
    // resolves to no teacher row, so the visibility filter denies everything
    // and she sees an empty programme. WhatsApp attribution goes through the
    // same link.
    //
    // It is a uuid field rather than a picker, matching schoolId. Copy the id
    // from /admin/users. Nullable, because a teacher on the roster who has not
    // been given an account yet is a legitimate state.
    userId: z.string().uuid().optional().nullable(),
    name: z.string().min(2).max(160),
    bio: z.string().max(2000).optional().nullable(),
    photoUrl: z.string().url().optional().nullable(),
    expertiseAreas: z.array(z.string()).default([]),
    active: z.boolean().default(true),
  }),
  formFields: ["name", "bio", "photoUrl", "expertiseAreas", "active", "userId"],
  describeRow: (r) => `mentor:${r.name ?? r.id}`,
};
