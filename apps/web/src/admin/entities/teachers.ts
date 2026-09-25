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
    { key: "joinedPhase", label: "Joined at" },
    { key: "currentPhaseId", label: "Current phase" },
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
    // Picked from the teacher accounts by name (admin/references.ts; the value
    // submitted is still the uuid). Nullable, because somebody on the roster
    // who has not been given an account yet is a legitimate state.
    userId: z.string().uuid().optional().nullable(),
    fullName: z.string().min(2).max(160),
    schoolId: z.string().uuid(),
    phone: z.string().max(32).optional().nullable(),
    subjectSpecialism: z.string().max(80).optional().nullable(),
    joinedPhase: z.string().max(16).optional().nullable(),
    // WHERE THE TEACHER IS NOW, as opposed to `joinedPhase`, which is where
    // they started. Two different questions; the admin only ever offered the
    // first one, so this column had no way to be set from any screen and was
    // NULL for every teacher in the database.
    //
    // That is what made /repo/teachers' phase filter useless: it filters on
    // this column, so every phase in its dropdown returned an empty table. An
    // empty result reads as "nobody is in Phase 2" rather than "this was never
    // filled in", which is how it went unnoticed.
    //
    // Picked from /admin/data/phases by label. Nullable -- a teacher on the
    // roster who has not started a phase yet is a real state.
    currentPhaseId: z.string().uuid().optional().nullable(),
    active: z.boolean().default(true),
  }),
  fields: {
    joinedPhase: { help: "Free text, e.g. \"Phase 1\" -- where the teacher started." },
    userId: { userRoles: ["teacher"] },
  },
  formFields: [
    "fullName",
    "schoolId",
    "phone",
    "subjectSpecialism",
    "joinedPhase",
    "currentPhaseId",
    "active",
    "userId",
  ],
  describeRow: (r) => `teacher:${r.fullName ?? r.id}`,
};
