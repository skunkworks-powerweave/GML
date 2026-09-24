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
      code: observationCycles.code,
      kind: observationCycles.kind,
      scheduledAt: observationCycles.scheduledAt,
      observerId: observationCycles.observerId,
      teacherId: observationCycles.teacherId,
      teacherUserId: teachers.userId,
      teacherName: teachers.fullName,
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
    const when = cycle.scheduledAt
      ? ` on ${cycle.scheduledAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`
      : "";
    const subject =
      event === "cycle.assigned"
        ? `Observation cycle ${cycle.code} assigned`
        : `Observation cycle ${cycle.code} signed off`;
    const body =
      event === "cycle.assigned"
        ? `A ${cycle.kind} observation of ${cycle.teacherName}${when}.`
        : `The cycle for ${cycle.teacherName} is complete; its forms and notes stay on the cycle page.`;
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
