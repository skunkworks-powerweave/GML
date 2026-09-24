// Row visibility and section access for the two gated sections -- observation
// and mentorship -- as functions of an explicit database handle.
//
// WHY THIS IS NOT INSIDE authz.ts. authz.ts begins `import "server-only"` and
// binds the module-level `db`, so nothing outside a Next render could execute
// the predicates it held. They were therefore never executed by any test, and
// three surfaces shipped without them: /repo/teacher/[id], /api/quickfind and
// the linked-cycle card on /repo/session/[id] each selected observation cycles
// and mentor pairings with a bare id or ILIKE predicate, re-serving to every
// signed-in user the rows /observation and /mentorship hide. Taking the handle
// as a parameter (the shape @gml/db/queue already uses) is what lets
// tests/behaviour/access-control.test.ts run these against a real Postgres.
// authz.ts re-exports the db-bound forms, so existing call sites are unchanged.
//
// No "server-only" marker, deliberately -- it would make this file unimportable
// by the tests that are the reason it exists. Nothing here is secret or reads
// the environment, and a client bundle cannot import it anyway: every caller
// passes a node-postgres handle.

import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  mentorPairings,
  mentors,
  observationCycles,
  sectionGateGrants,
  teachers,
} from "@gml/db/schema";
import { ADMIN_ROLES, hasAnyRole, type RoleName } from "@gml/shared/auth/roles";
import type { GateSlug } from "./gates";

export type Db = NodePgDatabase<Record<string, unknown>>;

export type Actor = { id: string; role: RoleName | string };

export const isAdmin = (actor: Actor): boolean => hasAnyRole(actor.role, ADMIN_ROLES);

/** Narrow a possibly-null session into the Actor shape these helpers take. */
export function actorFrom(session: {
  user?: { id?: string | null; role?: string | null } | null;
} | null): Actor | null {
  const id = session?.user?.id;
  const role = session?.user?.role;
  if (!id || !role) return null;
  return { id, role };
}

/** teachers.id for the signed-in user, or null if they are not a teacher. */
export async function teacherIdFor(db: Db, actor: Actor): Promise<string | null> {
  const [row] = await db
    .select({ id: teachers.id })
    .from(teachers)
    .where(eq(teachers.userId, actor.id))
    .limit(1);
  return row?.id ?? null;
}

/** mentors.id for the signed-in user, or null if they are not a mentor. */
export async function mentorIdFor(db: Db, actor: Actor): Promise<string | null> {
  const [row] = await db
    .select({ id: mentors.id })
    .from(mentors)
    .where(eq(mentors.userId, actor.id))
    .limit(1);
  return row?.id ?? null;
}

/** teachers.id values this mentor is actively paired with. */
export async function menteeTeacherIds(db: Db, mentorId: string): Promise<string[]> {
  const rows = await db
    .select({ teacherId: mentorPairings.teacherId })
    .from(mentorPairings)
    .where(and(eq(mentorPairings.mentorId, mentorId), eq(mentorPairings.status, "active")));
  return rows.map((r) => r.teacherId);
}

/**
 * Never-matches predicate, for a role with no legitimate rows in a list.
 *
 * Returning `undefined` here would mean "no restriction" and show the caller
 * EVERYTHING -- the exact inversion these filters exist to prevent -- so the
 * deny case has to be an explicit false rather than an absent clause.
 */
export const DENY_ALL: SQL = sql`false`;

/**
 * WHERE predicate scoping observation cycles to what `actor` may see.
 *
 * The list-surface mirror of assertCanAccessCycle:
 *   admin    -> undefined (no restriction)
 *   observer -> cycles they are the assigned observer of
 *   teacher  -> cycles about them
 *   mentor   -> cycles about a teacher they are actively paired with
 *   other    -> nothing
 *
 * Must be ANDed into the query. Filtering in JS would still transfer every row
 * out of Postgres and would leave any COUNT or heading built from the rows
 * unscoped.
 */
export async function cycleVisibility(db: Db, actor: Actor): Promise<SQL | undefined> {
  if (isAdmin(actor)) return undefined;

  if (actor.role === "observer") return eq(observationCycles.observerId, actor.id);

  if (actor.role === "teacher") {
    const tid = await teacherIdFor(db, actor);
    return tid ? eq(observationCycles.teacherId, tid) : DENY_ALL;
  }

  if (actor.role === "mentor") {
    const mid = await mentorIdFor(db, actor);
    if (!mid) return DENY_ALL;
    const teacherIds = await menteeTeacherIds(db, mid);
    return teacherIds.length ? inArray(observationCycles.teacherId, teacherIds) : DENY_ALL;
  }

  return DENY_ALL;
}

/**
 * WHERE predicate scoping mentor pairings to what `actor` may see.
 *
 * The list-surface mirror of assertCanAccessPairing:
 *   admin    -> undefined (no restriction)
 *   mentor   -> pairings they own
 *   teacher  -> pairings they are the mentee of
 *   observer -> nothing; observers have no role in mentorship at all
 */
export async function pairingVisibility(db: Db, actor: Actor): Promise<SQL | undefined> {
  if (isAdmin(actor)) return undefined;

  if (actor.role === "mentor") {
    const mid = await mentorIdFor(db, actor);
    return mid ? eq(mentorPairings.mentorId, mid) : DENY_ALL;
  }

  if (actor.role === "teacher") {
    const tid = await teacherIdFor(db, actor);
    return tid ? eq(mentorPairings.teacherId, tid) : DENY_ALL;
  }

  return DENY_ALL;
}

/**
 * The caller's live grant for a section gate, or null.
 *
 * lib/gates.ts getActiveGrant() is this, bound to the app's db -- one
 * definition of "holds the section password", so a rotation (which deletes the
 * grant rows) closes every surface at once.
 */
export async function activeGrant(db: Db, userId: string, slug: GateSlug) {
  const [row] = await db
    .select()
    .from(sectionGateGrants)
    .where(
      and(
        eq(sectionGateGrants.userId, userId),
        eq(sectionGateGrants.gateSlug, slug),
        gt(sectionGateGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sectionGateGrants.expiresAt))
    .limit(1);
  return row ?? null;
}

/**
 * What `actor` may read of one gated section, decided in one place.
 *
 * Two independent controls guard observation and mentorship rows, and a
 * surface that re-serves those rows outside the section has to apply BOTH:
 *
 *   - the section gate: one shared, rotatable password per section, which the
 *     product advertises as the control for these two sections. It answers
 *     "may you enter", never "whose rows".
 *   - the visibility predicate: which rows, for this actor.
 *
 * /observation and /mentorship get the gate from their layouts and the
 * predicate from their queries. Anything outside those segments -- /repo,
 * /api/quickfind -- gets neither for free, which is how both leaked.
 *
 * `granted: false` means the caller has not unlocked the section; a surface
 * should render its "locked" state and run no query at all, so not even a count
 * escapes. The predicate is resolved only when the grant is held.
 */
export type SectionAccess<S extends "observation" | "mentorship"> =
  | { section: S; granted: false }
  | { section: S; granted: true; where: SQL | undefined };

export type ObservationAccess = SectionAccess<"observation">;
export type MentorshipAccess = SectionAccess<"mentorship">;

export async function observationAccess(db: Db, actor: Actor): Promise<ObservationAccess> {
  if (!(await activeGrant(db, actor.id, "observation"))) {
    return { section: "observation", granted: false };
  }
  return { section: "observation", granted: true, where: await cycleVisibility(db, actor) };
}

export async function mentorshipAccess(db: Db, actor: Actor): Promise<MentorshipAccess> {
  if (!(await activeGrant(db, actor.id, "mentorship"))) {
    return { section: "mentorship", granted: false };
  }
  return { section: "mentorship", granted: true, where: await pairingVisibility(db, actor) };
}
