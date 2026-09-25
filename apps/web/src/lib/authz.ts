import "server-only";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@gml/db";
import {
  mentorMeetings,
  mentorPairings,
  observationCycles,
  videoSubmissions,
} from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import {
  cycleVisibility,
  isAdmin,
  menteeTeacherIds as menteeTeacherIdsIn,
  mentorIdFor as mentorIdIn,
  pairingVisibility,
  teacherIdFor as teacherIdIn,
  type Actor,
} from "./visibility";

/**
 * Object-level authorization.
 *
 * The app enforced ROLE but never OWNERSHIP. A role check answers "may a mentor
 * do this kind of thing"; it never asked "is this mentor's mentee". The schema
 * has carried the answer all along -- observation_cycles.observer_id and
 * .teacher_id, mentor_pairings.mentor_id and .teacher_id,
 * video_submissions.submitted_by_user_id -- and no code read it. So any
 * authenticated user could open any observation cycle, submit its forms, sign
 * it off, log meetings against any mentorship pairing, and play any video in
 * the programme from a guessed UUID.
 *
 * WHY notFound() AND NOT redirect("/forbidden"):
 * a role failure is honestly a 403 -- "you lack the role" -- and saying so
 * leaks nothing. An ownership failure is different: answering 403 for
 * /observation/<uuid> confirms that uuid names a real cycle, which is exactly
 * the enumeration signal we are trying to remove. Unauthorised rows must be
 * indistinguishable from absent ones.
 *
 * Each helper RETURNS the row it authorised, so call sites replace their
 * existing SELECT rather than paying for a second round-trip.
 */

// Ownership lookups and list predicates live in lib/visibility.ts, which takes
// the database as a parameter so the behaviour suite can execute them. These
// are the same functions bound to the app's db; every existing import of
// cycleVisibilityFilter / pairingVisibilityFilter / actorFrom is unchanged.
export type { Actor } from "./visibility";
export { actorFrom } from "./visibility";

const teacherIdFor = (actor: Actor) => teacherIdIn(db, actor);
const mentorIdFor = (actor: Actor) => mentorIdIn(db, actor);
const menteeTeacherIds = (mentorId: string) => menteeTeacherIdsIn(db, mentorId);

/**
 * Every id these helpers take arrives from a URL segment or a form body.
 *
 * Postgres raises 22P02 ("invalid input syntax for type uuid") when a
 * non-uuid string is compared against a uuid column, which surfaces as an
 * unhandled exception -- a 500, or a blank page before this codebase had any
 * error boundary. /observation/not-a-uuid did exactly that, on the same helper
 * whose entire design principle is that an unauthorised row must be
 * indistinguishable from an absent one. A 500 is very distinguishable.
 *
 * A malformed id cannot name a row, so notFound() is both the safe answer and
 * the correct one.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same test, for callers that answer a malformed id themselves. */
export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function assertUuid(id: string): void {
  if (!UUID_RE.test(id)) notFound();
}

/**
 * Authorise access to an observation cycle.
 *
 *   admin    -> any cycle
 *   observer -> cycles where they are the assigned observer
 *   teacher  -> cycles about them
 *   mentor   -> cycles about a teacher they are actively paired with
 */
export async function assertCanAccessCycle(actor: Actor, cycleId: string) {
  assertUuid(cycleId);
  const [cycle] = await db
    .select()
    .from(observationCycles)
    .where(eq(observationCycles.id, cycleId))
    .limit(1);
  if (!cycle) notFound();
  if (isAdmin(actor)) return cycle;

  if (actor.role === "observer" && cycle.observerId === actor.id) return cycle;

  if (actor.role === "teacher") {
    const tid = await teacherIdFor(actor);
    if (tid && tid === cycle.teacherId) return cycle;
  }

  if (actor.role === "mentor") {
    const mid = await mentorIdFor(actor);
    if (mid) {
      const [pair] = await db
        .select({ id: mentorPairings.id })
        .from(mentorPairings)
        .where(
          and(
            eq(mentorPairings.mentorId, mid),
            eq(mentorPairings.teacherId, cycle.teacherId),
            eq(mentorPairings.status, "active"),
          ),
        )
        .limit(1);
      if (pair) return cycle;
    }
  }

  notFound();
}

/**
 * Authorise access to a mentorship pairing.
 *
 *   admin    -> any pairing
 *   mentor   -> pairings they own
 *   teacher  -> pairings they are the mentee of
 *   observer -> denied; observers have no mentorship role
 */
export async function assertCanAccessPairing(actor: Actor, pairingId: string) {
  assertUuid(pairingId);
  const [pairing] = await db
    .select()
    .from(mentorPairings)
    .where(eq(mentorPairings.id, pairingId))
    .limit(1);
  if (!pairing) notFound();
  if (isAdmin(actor)) return pairing;

  if (actor.role === "mentor") {
    const mid = await mentorIdFor(actor);
    if (mid && mid === pairing.mentorId) return pairing;
  }

  if (actor.role === "teacher") {
    const tid = await teacherIdFor(actor);
    if (tid && tid === pairing.teacherId) return pairing;
  }

  notFound();
}

/**
 * Authorise access to a video submission.
 *
 * Videos are the most sensitive surface here -- mentorship meeting recordings
 * and mentee quarterly videos live in the same table as cohort-wide
 * teach-backs. Access resolves through whatever the clip is ATTACHED to,
 * because context_id deliberately carries no foreign key.
 */
export async function assertCanAccessVideo(actor: Actor, videoId: string) {
  assertUuid(videoId);
  const [video] = await db
    .select()
    .from(videoSubmissions)
    .where(eq(videoSubmissions.id, videoId))
    .limit(1);
  if (!video) notFound();
  if (isAdmin(actor)) return video;

  // Your own upload, whatever it is attached to.
  if (video.submittedByUserId && video.submittedByUserId === actor.id) return video;

  switch (video.contextType) {
    case "observation_cycle":
      if (video.contextId) {
        // notFound()s from inside if the actor may not see the cycle.
        await assertCanAccessCycle(actor, video.contextId);
        return video;
      }
      break;

    case "mentee_quarterly":
      if (video.contextId) {
        await assertCanAccessPairing(actor, video.contextId);
        return video;
      }
      break;

    case "mentor_meeting":
      if (video.contextId) {
        const [meeting] = await db
          .select({ pairingId: mentorMeetings.pairingId })
          .from(mentorMeetings)
          .where(eq(mentorMeetings.id, video.contextId))
          .limit(1);
        if (meeting) {
          await assertCanAccessPairing(actor, meeting.pairingId);
          return video;
        }
      }
      break;

    case "teach_back":
      // Teach-backs are a cohort activity reviewed by mentors and observers.
      if (hasAnyRole(actor.role, ["mentor", "observer"])) return video;
      break;

    default:
      // classroom_session / generic carry no ownership edge we can verify, so
      // they stay admin-or-submitter only. Widen deliberately, never by default.
      break;
  }

  notFound();
}

/**
 * WHERE predicate scoping a video LIST to what `actor` may see.
 *
 * Returns undefined for admins (no restriction). This must be ANDed into the
 * query rather than filtered in JS: /videos previously selected every row in
 * the table with no user predicate at all, so a teacher could page through the
 * entire programme's mentorship recordings.
 */
export async function videoVisibilityFilter(actor: Actor): Promise<SQL | undefined> {
  if (isAdmin(actor)) return undefined;

  const clauses: SQL[] = [eq(videoSubmissions.submittedByUserId, actor.id)];

  const cycleScope = (ids: string[]): SQL | undefined =>
    ids.length
      ? (and(
          eq(videoSubmissions.contextType, "observation_cycle"),
          inArray(videoSubmissions.contextId, ids),
        ) as SQL)
      : undefined;

  if (actor.role === "observer") {
    const rows = await db
      .select({ id: observationCycles.id })
      .from(observationCycles)
      .where(eq(observationCycles.observerId, actor.id));
    const scoped = cycleScope(rows.map((r) => r.id));
    if (scoped) clauses.push(scoped);
    clauses.push(eq(videoSubmissions.contextType, "teach_back"));
  }

  if (actor.role === "teacher") {
    const tid = await teacherIdFor(actor);
    if (tid) {
      const rows = await db
        .select({ id: observationCycles.id })
        .from(observationCycles)
        .where(eq(observationCycles.teacherId, tid));
      const scoped = cycleScope(rows.map((r) => r.id));
      if (scoped) clauses.push(scoped);
    }
  }

  if (actor.role === "mentor") {
    const mid = await mentorIdFor(actor);
    if (mid) {
      const teacherIds = await menteeTeacherIds(mid);
      if (teacherIds.length) {
        const rows = await db
          .select({ id: observationCycles.id })
          .from(observationCycles)
          .where(inArray(observationCycles.teacherId, teacherIds));
        const scoped = cycleScope(rows.map((r) => r.id));
        if (scoped) clauses.push(scoped);
      }

      const pairIds = (
        await db
          .select({ id: mentorPairings.id })
          .from(mentorPairings)
          .where(eq(mentorPairings.mentorId, mid))
      ).map((r) => r.id);

      if (pairIds.length) {
        clauses.push(
          and(
            eq(videoSubmissions.contextType, "mentee_quarterly"),
            inArray(videoSubmissions.contextId, pairIds),
          ) as SQL,
        );

        const meetingIds = (
          await db
            .select({ id: mentorMeetings.id })
            .from(mentorMeetings)
            .where(inArray(mentorMeetings.pairingId, pairIds))
        ).map((r) => r.id);

        if (meetingIds.length) {
          clauses.push(
            and(
              eq(videoSubmissions.contextType, "mentor_meeting"),
              inArray(videoSubmissions.contextId, meetingIds),
            ) as SQL,
          );
        }
      }
    }
    clauses.push(eq(videoSubmissions.contextType, "teach_back"));
  }

  // The "own uploads" clause is always present, so this is never an empty OR.
  return clauses.length === 1 ? clauses[0] : (or(...clauses) as SQL);
}

/**
 * WHERE predicate scoping an observation-cycle LIST to what `actor` may see.
 *
 * The mirror of assertCanAccessCycle, for the list surface. /observation
 * selected every cycle in the programme with a WHERE built only from the
 * ?status= and ?kind= chips, so any user holding the observation section
 * password -- which is how a teacher is let in to view her OWN cycle -- was
 * served 80 rows of other teachers' names, subjects, evaluative cycle kinds and
 * real cycle UUIDs. The detail page at the far end of each of those links was
 * already guarded; the list was not.
 *
 * The section gate cannot substitute for this: it is one shared rotatable
 * password per section and answers "may you enter", never "whose rows". A
 * surface OUTSIDE the section needs both -- see observationAccess() in
 * lib/visibility.ts and the reads in lib/gated-reads.ts.
 *
 * Must be ANDed into the query. Filtering in JS would still transfer every row
 * out of Postgres and would leave the GROUP BY chip counts unscoped -- the same
 * half-fix /videos had to correct once already.
 */
export async function cycleVisibilityFilter(actor: Actor): Promise<SQL | undefined> {
  return cycleVisibility(db, actor);
}

/**
 * WHERE predicate scoping a mentorship-pairing LIST to what `actor` may see.
 *
 * The mirror of assertCanAccessPairing. /mentorship had the same defect as
 * /observation: the detail page refuses to show a teacher anyone else's
 * pairing, while the list showed her all of them -- every mentor's name and
 * base location, every mentee's name, meeting counts and last-meeting dates.
 *
 * Observers are denied outright rather than given a narrow scope, matching
 * assertCanAccessPairing: observers have no role in mentorship at all.
 */
export async function pairingVisibilityFilter(actor: Actor): Promise<SQL | undefined> {
  return pairingVisibility(db, actor);
}

