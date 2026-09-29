// The numbers derived from students' attendance, kept true when the data
// tables write it.
//
// A session's attended / total counts and each student's attendance % are
// derived from session_attendance (lib/teaching/records.ts
// recomputeSessionCounts / refreshLearnerAttendance; the design: "A session's
// attended/total counts and a learner's attendance % are derived from it").
// The teacher's marking screen recomputes them; a grid or CSV write of an
// attendance row, a student, or a session did not, so a mark an administrator
// corrected here left the session's counts and the child's % as they were --
// and deleting a student (whose marks cascade) or a session (whose marks
// cascade) left them counting marks that no longer exist.
//
// Every grid path (create, update, delete, bulk delete, CSV import) runs its
// write through keepDerivedCounts, in its own transaction:
//
//   session-attendance  the sessions and students of the rows before and after
//   learners            the sessions she was marked in (read before a delete)
//   sessions            the students marked in it (a cancelled session does
//                       not count toward a %); its own counts are NOT
//                       recomputed, since a session with no marks keeps the
//                       counts an administrator typed
//
// Server-only: the entity definitions are also bundled for the browser
// (row-form.tsx reads the registry), so this is not declared on them.

import "server-only";
import { inArray } from "drizzle-orm";
import { sessionAttendance } from "@gml/db/schema";
import { recomputeSessionCounts, refreshLearnerAttendance } from "@/lib/teaching/records";
import type { AdminDb } from "./types";

type Tx = Parameters<typeof recomputeSessionCounts>[0];

const ids = (rows: Array<Record<string, unknown>>, key: string): string[] => [
  ...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === "string" && v.length > 0)),
];

/** Does a write to this entity move a derived number? */
export function hasDerivedCounts(slug: string): boolean {
  return slug === "session-attendance" || slug === "learners" || slug === "sessions";
}

/**
 * Run `write` and bring the derived numbers it moves up to date, in `tx`.
 * `rows` are the rows the write touches, as stored before it and as written
 * (either may be absent: a create has no before, a delete no after).
 */
export async function keepDerivedCounts<T>(
  slug: string,
  tx: AdminDb,
  rows: Array<Record<string, unknown>>,
  write: () => Promise<T>,
): Promise<T> {
  if (!hasDerivedCounts(slug)) return write();
  const db = tx as unknown as Tx;
  let sessionIds: string[] = [];
  let learnerIds: string[] = [];
  if (slug === "session-attendance") {
    sessionIds = ids(rows, "sessionId");
    learnerIds = ids(rows, "learnerId");
  } else if (slug === "learners") {
    // Her sessions' counts; not her own %, which an edit of her name must
    // not recompute over what an administrator typed.
    const learners = ids(rows, "id");
    if (learners.length) {
      const marked = await tx
        .select({ sessionId: sessionAttendance.sessionId })
        .from(sessionAttendance)
        .where(inArray(sessionAttendance.learnerId, learners));
      sessionIds = ids(marked, "sessionId");
    }
  } else {
    const sessions = ids(rows, "id");
    if (sessions.length) {
      const marked = await tx
        .select({ learnerId: sessionAttendance.learnerId })
        .from(sessionAttendance)
        .where(inArray(sessionAttendance.sessionId, sessions));
      learnerIds = ids(marked, "learnerId");
    }
  }
  const result = await write();
  // A session or student the write deleted is simply not found.
  for (const id of sessionIds) await recomputeSessionCounts(db, id);
  await refreshLearnerAttendance(db, learnerIds);
  return result;
}
