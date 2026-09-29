import "server-only";

// Who is asking, for the /teaching pages and their server actions.
//
// A server action is a public endpoint: Next runs it before any layout, and a
// form's hidden fields are whatever the caller typed. So every action starts
// here -- signed in, a teacher, with an active teachers row -- and then checks
// that the record it touches is hers (./index.ts, ./records.ts). The pages do
// the same through requireRole and myTeacher, so a page and its action cannot
// disagree about who may do what.

import { redirect } from "next/navigation";
import { db } from "@gml/db";
import { auth } from "@/auth";
import { actorFrom, type Actor } from "@/lib/visibility";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { myTeacher, type MyTeacher } from "./index";

/** Programme admins and super admins: the approvers, who read her records. */
export const APPROVER_ROLES = ["programme_admin", "super_admin"] as const;

export const isApprover = (actor: Actor): boolean => hasAnyRole(actor.role, APPROVER_ROLES);

export type TeacherRefusal = "notTeacher" | "noTeacherRecord";

/**
 * The signed-in teacher and her teachers row. Signed out goes to /login; any
 * other role, or a teacher account with no active teachers row, is refused
 * with the reason (an errors.* key of the teaching namespace).
 */
export async function signedInTeacher(): Promise<{ actor: Actor; teacher: MyTeacher } | { refused: TeacherRefusal }> {
  const actor = actorFrom(await auth());
  if (!actor) redirect("/login");
  if (actor.role !== "teacher") return { refused: "notTeacher" };
  const teacher = await myTeacher(db, actor);
  if (!teacher) return { refused: "noTeacherRecord" };
  return { actor, teacher };
}
