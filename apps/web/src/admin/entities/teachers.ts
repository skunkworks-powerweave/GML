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
    { key: "userId", label: "Login account" },
    { key: "fullName", label: "Name" },
    { key: "schoolId", label: "School" },
    { key: "phone", label: "Phone" },
    { key: "subjectSpecialism", label: "Subject" },
    { key: "joinedPhase", label: "Phase" },
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
    fullName: z.string().min(2).max(160),
    schoolId: z.string().uuid(),
    phone: z.string().max(32).optional().nullable(),
    subjectSpecialism: z.string().max(80).optional().nullable(),
    joinedPhase: z.string().max(16).optional().nullable(),
    active: z.boolean().default(true),
  }),
  formFields: ["fullName", "schoolId", "phone", "subjectSpecialism", "joinedPhase", "active", "userId"],
  describeRow: (r) => `teacher:${r.fullName ?? r.id}`,
};
