// Observation-cycle notifications: who is told when a cycle is assigned, and
// when it is signed off.
//
// Until 2026-09 nothing in the observation journey wrote a notification.
// Nominating a cycle told neither the teacher nor the observer; signing one
// off told nobody -- while the settings page offered "Cycle assigned" and
// "Cycle complete" toggles and /inbox was ready to link both kinds to the
// cycle. Whether a kind is SHOWN is decided at read time
// (lib/notification-kinds.ts); writing is unconditional (@gml/db/notify).
//
// NOTHING THE SECTION PASSWORD GUARDS. The bell and /inbox are outside the
// Observation section, and a notification is text copied into another table,
// so the read-time rule the dashboard and lib/gated-reads.ts follow ("no
// grant, no query": cycle codes, teachers, kinds) cannot apply to it. The
// subject and body used to name the cycle's code, its teacher, its kind and
// its date, which /inbox showed to every party whether or not they had
// unlocked the section. They now say only that there is a cycle; the entity
// link opens it through the gate, which returns the reader to that cycle.
//
// Database as a parameter, no "server-only": tests/behaviour runs it.

import { and, eq, isNotNull } from "drizzle-orm";
import { mentorPairings, mentors, observationCycles, teachers } from "@gml/db/schema";
import { notify } from "@gml/db/notify";
import type { Db } from "../visibility";

/**
 * Everyone on a cycle: the teacher (when she has a login), the assigned
 * observer, and the mentors actively paired with the teacher.
 */
async function cycleParties(db: Db, cycleId: string) {
  const [row] = await db
    .select({
      observerId: observationCycles.observerId,
      teacherId: observationCycles.teacherId,
      teacherUserId: teachers.userId,
    })
    .from(observationCycles)
    .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
    .where(eq(observationCycles.id, cycleId))
    .limit(1);
  if (!row) return null;
  const mentorUsers = await db
    .select({ userId: mentors.userId })
    .from(mentorPairings)
    .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
    .where(
      and(
        eq(mentorPairings.teacherId, row.teacherId),
        eq(mentorPairings.status, "active"),
        isNotNull(mentors.userId),
      ),
    );
  const userIds = [row.teacherUserId, row.observerId, ...mentorUsers.map((m) => m.userId)].filter(
    (id): id is string => Boolean(id),
  );
  return { ...row, userIds };
}

/**
 * Tell a cycle's parties -- everyone but the person who acted -- that it was
 * assigned or has been signed off. Never throws (notify() logs a failure), so
 * a notification can never undo the action it reports.
 */
export async function notifyCycleParties(
  db: Db,
  event: "cycle.assigned" | "cycle.complete",
  cycleId: string,
  actorUserId: string,
): Promise<number> {
  try {
    const cycle = await cycleParties(db, cycleId);
    if (!cycle) return 0;
    // Generic on purpose: see the header.
    const subject =
      event === "cycle.assigned"
        ? "You have been added to an observation cycle"
        : "An observation cycle you are part of has been signed off";
    const body =
      event === "cycle.assigned"
        ? "Open it to see which cycle and when; the Observation section asks for its password first."
        : "Its forms and notes stay on the cycle page in the Observation section.";
    return await notify(
      db,
      cycle.userIds.map((userId) => ({
        userId,
        kind: event,
        subject,
        body,
        entityType: "observation_cycle",
        entityId: cycleId,
      })),
      { excludeUserId: actorUserId },
    );
  } catch (err) {
    console.error("[observation] could not notify the cycle's parties", { event, cycleId, err });
    return 0;
  }
}
