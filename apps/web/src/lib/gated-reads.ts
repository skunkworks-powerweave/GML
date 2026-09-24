// Observation-cycle and mentor-pairing reads for surfaces OUTSIDE the two gated
// sections: /repo/teacher/[id], /repo/session/[id] and /api/quickfind.
//
// WHAT WAS WRONG. Each of those surfaces ran its own select over
// observation_cycles / mentor_pairings with a bare `teacher_id = $1`,
// `id = $1` or `code ILIKE $1`, and sat outside the /observation and
// /mentorship layouts that enforce the section password. So every signed-in
// user could read, for any teacher in the programme: her cycle codes, topics,
// evaluative-vs-developmental kind and stage; who mentors her, the mentor's
// base location and how many times they have met -- with the real UUIDs as
// links. /repo/mentor/[id] had already been fixed for the pairing roster; these
// three had not.
//
// THE RULE. Every read here takes a SectionAccess from lib/visibility.ts:
//   - not granted (the caller has not unlocked the section) -> no query runs;
//     history reads return null so the page can render its locked state, and
//     search reads return [] so quickfind simply has nothing of that kind;
//   - granted -> the actor's visibility predicate is ANDed into the SQL. Never
//     filtered in JS: /repo/teacher renders `recentCycles.length` in a heading,
//     so a JS filter would still leak the count.
//
// Keeping the queries here rather than inline is what lets
// tests/behaviour/access-control.test.ts execute the exact SQL the surfaces run.

import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { mentorPairings, mentors, observationCycles, teachers } from "@gml/db/schema";
import { DENY_ALL, type Db, type MentorshipAccess, type ObservationAccess } from "./visibility";

/** `base AND where`, where an absent `where` (admin) adds nothing. */
function scoped(base: SQL | undefined, where: SQL | undefined): SQL | undefined {
  return and(base, ...(where ? [where] : []));
}

/** /repo/teacher/[id] "Recent observation cycles". null = section locked. */
export async function teacherCycleHistory(
  db: Db,
  access: ObservationAccess,
  teacherId: string,
  limit = 6,
) {
  if (!access.granted) return null;
  return db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      status: observationCycles.status,
      scheduledAt: observationCycles.scheduledAt,
      topic: observationCycles.topic,
    })
    .from(observationCycles)
    .where(scoped(eq(observationCycles.teacherId, teacherId), access.where))
    .orderBy(desc(observationCycles.scheduledAt))
    .limit(limit);
}

/** /repo/teacher/[id] "Mentor pairing". null = section locked. */
export async function teacherPairingHistory(
  db: Db,
  access: MentorshipAccess,
  teacherId: string,
  limit = 5,
) {
  if (!access.granted) return null;
  return db
    .select({
      id: mentorPairings.id,
      status: mentorPairings.status,
      startedAt: mentorPairings.startedAt,
      currentQuarter: mentorPairings.currentQuarter,
      meetingsCount: mentorPairings.meetingsCount,
      lastMeetingAt: mentorPairings.lastMeetingAt,
      mentorId: mentors.id,
      mentorName: mentors.name,
      mentorHindi: mentors.hindiName,
      mentorBase: mentors.baseLocation,
    })
    .from(mentorPairings)
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .where(scoped(eq(mentorPairings.teacherId, teacherId), access.where))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(limit);
}

/**
 * /repo/mentor/[id] pairing roster: the mentor's mentees and their meeting
 * history. That page already ANDed the visibility predicate in, but served the
 * roster without the mentorship section password -- so /repo/mentor showed
 * what /repo/teacher now locks. null = section locked.
 */
export async function mentorRoster(
  db: Db,
  access: MentorshipAccess,
  mentorId: string,
  limit = 120,
) {
  if (!access.granted) return null;
  return db
    .select({
      id: mentorPairings.id,
      status: mentorPairings.status,
      currentQuarter: mentorPairings.currentQuarter,
      meetingsCount: mentorPairings.meetingsCount,
      lastMeetingAt: mentorPairings.lastMeetingAt,
      startedAt: mentorPairings.startedAt,
      endedAt: mentorPairings.endedAt,
      teacherId: mentorPairings.teacherId,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(mentorPairings)
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .where(scoped(eq(mentorPairings.mentorId, mentorId), access.where))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(limit);
}

/** /api/quickfind cycles: `code ILIKE pattern`, scoped. [] when locked. */
export async function searchCycles(
  db: Db,
  access: ObservationAccess,
  pattern: string,
  limit: number,
) {
  if (!access.granted) return [];
  return db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      topic: observationCycles.topic,
    })
    .from(observationCycles)
    .where(scoped(ilike(observationCycles.code, pattern), access.where))
    .orderBy(asc(observationCycles.code))
    .limit(limit);
}

/** /api/quickfind pairings: mentor OR teacher name ILIKE pattern, scoped. [] when locked. */
export async function searchPairings(
  db: Db,
  access: MentorshipAccess,
  pattern: string,
  limit: number,
) {
  if (!access.granted) return [];
  return db
    .select({
      id: mentorPairings.id,
      mentorName: mentors.name,
      teacherName: teachers.fullName,
    })
    .from(mentorPairings)
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .where(
      scoped(or(ilike(mentors.name, pattern), ilike(teachers.fullName, pattern)), access.where),
    )
    .limit(limit);
}

/**
 * /repo/teachers "Obs. cycles" column: a per-teacher count subquery, over only
 * the cycles the viewer may see. It counted every cycle in the programme, so
 * the directory told any signed-in user how many times each colleague had been
 * observed. Locked -> counts nothing (the page renders "—", not a false 0).
 * A subquery rather than rows, because the page LEFT JOINs it into its one
 * teachers select.
 */
export function cycleCountsByTeacher(db: Db, access: ObservationAccess) {
  return db
    .select({
      teacherId: observationCycles.teacherId,
      cyclesTotal: sql<number>`count(*)::int`.as("cycles_total"),
    })
    .from(observationCycles)
    .where(access.granted ? access.where : DENY_ALL)
    .groupBy(observationCycles.teacherId)
    .as("cycle_counts");
}

/**
 * /repo/session/[id] linked cycle: the cycle a session was observed under, if
 * the viewer may open it. null when locked, absent, or not theirs -- the card
 * names the cycle's code and links its UUID, so "not yours" and "none" must
 * look the same.
 */
export async function linkedCycle(db: Db, access: ObservationAccess, cycleId: string) {
  if (!access.granted) return null;
  const [c] = await db
    .select({ id: observationCycles.id, code: observationCycles.code })
    .from(observationCycles)
    .where(scoped(eq(observationCycles.id, cycleId), access.where))
    .limit(1);
  return c ?? null;
}
