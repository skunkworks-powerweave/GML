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
    // A uuid field rather than a picker, matching schoolId. Copy the id from
    // /admin/users. Nullable, because somebody on the roster who has not been
    // given an account yet is a legitimate state.
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
