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
    // LINK TO A LOGIN ACCOUNT -- REPAIRABLE, not just settable once.
    //
    // /admin/users already links one at account-creation time: its form offers
    // a dropdown of unlinked teachers and mentors, and createUserAction writes
    // teachers.user_id / mentors.user_id (admin/users/actions.ts:180-181).
    // That is the normal path and it works.
    //
    // What did not exist was any way to CHANGE it afterwards. That line was
    // the only write to the column in the whole codebase, so a link skipped at
    // creation, or pointed at the wrong person, could not be corrected from any
    // screen -- and the consequence is not subtle. lib/authz.ts resolves a
    // signed-in teacher through teachers.user_id (teacherIdFor), which is what
    // cycleVisibilityFilter and assertCanAccessCycle are built on, so an
    // unlinked teacher sees an empty programme and 404s on the cycle that is
    // about her. WhatsApp attribution rides on the same column.
    //
    // Picked from the mentor accounts by name (admin/references.ts; the value
    // submitted is still the uuid). Nullable, because somebody on the roster
    // who has not been given an account yet is a legitimate state.
    userId: z.string().uuid().optional().nullable(),
    name: z.string().min(2).max(160),
    bio: z.string().max(2000).optional().nullable(),
    photoUrl: z.string().url().optional().nullable(),
    expertiseAreas: z.array(z.string()).default([]),
    active: z.boolean().default(true),
  }),
  fields: {
    photoUrl: { label: "Photo URL" },
    expertiseAreas: { label: "Expertise areas" },
    userId: { label: "Login account", userRoles: ["mentor"] },
  },
  formFields: ["name", "bio", "photoUrl", "expertiseAreas", "active", "userId"],
  // A mentor list re-uploaded after a partial import (csv.ts).
  duplicateKey: ["name"],
  describeRow: (r) => `mentor:${r.name ?? r.id}`,
};
