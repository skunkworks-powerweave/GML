import "server-only";

// What of the Repository (/repo) and quick find (/api/quickfind) the viewer may
// read. A TEACHER sees her own records only; every other role keeps the
// programme-wide view it had.
//
//   her profile      her own teachers row (lib/teaching myTeacher)
//   her school       the school on that row, without other teachers' rosters
//                    or their sessions
//   her classes      the classes she is linked to (teacher_classes)
//   her students     active, not deleted learners of those classes, limited to
//                    the link's section when it names one -- lib/teaching
//                    roster()'s rule, so the Repository and "My students" agree
//   her sessions     sessions with her teacher_id
//   outlines         approved programme outlines (no owner) and her own plans
//   her mentor(s)    mentors with a pairing to her, of any status
//   reference data   subjects, reading material and RTT content stay visible
//
// Other teachers' profiles, phone numbers, sessions, classes, rosters and plans
// answer 404 on a record page and are absent from every list and count. A
// teacher account with no (active) teachers row owns nothing.
//
// Every predicate here returns `undefined` for a viewer with the wide view (no
// restriction, so admin SQL is unchanged) and DENY_ALL -- never `undefined` --
// when a teacher owns nothing of that kind. Design:
// docs/superpowers/specs/2026-09-28-teaching-records-design.md ("Privacy: the
// Repository for teachers"). Executed in tests/behaviour/repo-privacy-*.test.ts.

import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { classes, courseOutlines, learners, mentorPairings, mentors, schools, sessions, teachers } from "@gml/db/schema";
import { DENY_ALL, type Actor, type Db } from "@/lib/visibility";
import { myClassLinks, myTeacher, type ClassLink, type MyTeacher } from "./index";

export type RepoScope =
  /** Admins, mentors, observers: the programme-wide view. */
  | { own: false }
  /** A teacher: her own records. `teacher` is null when she has no active teachers row. */
  | { own: true; teacher: MyTeacher | null; links: ClassLink[] };

/** The viewer's Repository scope, resolved once per request. */
export async function repoScope(db: Db, actor: Actor): Promise<RepoScope> {
  if (actor.role !== "teacher") return { own: false };
  const teacher = await myTeacher(db, actor);
  const links = teacher ? await myClassLinks(db, teacher.id) : [];
  return { own: true, teacher, links };
}

const ownId = (scope: RepoScope): string | null => (scope.own ? (scope.teacher?.id ?? null) : null);

// ── list predicates (AND them into the query) ────────────────────────────────

/** teachers rows: herself. */
export function teachersWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  const id = ownId(scope);
  return id ? eq(teachers.id, id) : DENY_ALL;
}

/** Classroom sessions: hers. */
export function sessionsWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  const id = ownId(scope);
  return id ? eq(sessions.teacherId, id) : DENY_ALL;
}

/** Schools: hers. */
export function schoolsWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  return scope.teacher ? eq(schools.id, scope.teacher.schoolId) : DENY_ALL;
}

/** Classes: the ones she teaches (any section of). */
export function classesWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  const ids = [...new Set(scope.links.map((l) => l.classId))];
  return ids.length ? inArray(classes.id, ids) : DENY_ALL;
}

/**
 * Learners: her students. Optionally one class of hers only. A link with no
 * section covers the whole grade; a link to section A covers section A and the
 * class's learners with no section recorded, as lib/teaching roster() does.
 */
export function learnersWhere(scope: RepoScope, classId?: string): SQL | undefined {
  if (!scope.own) return undefined;
  const links = scope.links.filter((l) => classId === undefined || l.classId === classId);
  if (!links.length) return DENY_ALL;
  const perLink = links.map((l) =>
    l.section == null
      ? eq(learners.classId, l.classId)
      : and(eq(learners.classId, l.classId), or(eq(learners.section, l.section), isNull(learners.section))),
  );
  return and(eq(learners.active, true), isNull(learners.deletedAt), or(...perLink));
}

/** Course outlines: approved programme outlines, and her own plans in any state. */
export function outlinesWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  const id = ownId(scope);
  const programme = and(isNull(courseOutlines.ownerTeacherId), eq(courseOutlines.approvalStatus, "approved"))!;
  return id ? or(programme, eq(courseOutlines.ownerTeacherId, id)) : programme;
}

/** Mentors: the ones she has (or had) a pairing with. */
export function mentorsWhere(scope: RepoScope): SQL | undefined {
  if (!scope.own) return undefined;
  const id = ownId(scope);
  return id
    ? inArray(mentors.id, sql`(SELECT ${mentorPairings.mentorId} FROM ${mentorPairings} WHERE ${mentorPairings.teacherId} = ${id})`)
    : DENY_ALL;
}

/** " AND <predicate>" for a correlated count written as raw SQL; nothing for the wide view. */
export function andAlso(predicate: SQL | undefined): SQL {
  return predicate ? sql` and ${predicate}` : sql``;
}

// ── record checks (a record page answers 404 when these say no) ─────────────

export function mayOpenTeacher(scope: RepoScope, teacherId: string): boolean {
  return !scope.own || ownId(scope) === teacherId;
}

export function mayOpenSession(scope: RepoScope, session: { teacherId: string }): boolean {
  return !scope.own || (ownId(scope) !== null && ownId(scope) === session.teacherId);
}

export function mayOpenSchool(scope: RepoScope, schoolId: string): boolean {
  return !scope.own || scope.teacher?.schoolId === schoolId;
}

export function mayOpenClass(scope: RepoScope, classId: string): boolean {
  return !scope.own || scope.links.some((l) => l.classId === classId);
}

export function mayOpenOutline(scope: RepoScope, outline: { ownerTeacherId: string | null; approvalStatus: string }): boolean {
  if (!scope.own) return true;
  if (outline.ownerTeacherId == null) return outline.approvalStatus === "approved";
  return outline.ownerTeacherId === ownId(scope);
}

export async function mayOpenMentor(db: Db, scope: RepoScope, mentorId: string): Promise<boolean> {
  if (!scope.own) return true;
  const id = ownId(scope);
  if (!id) return false;
  const [row] = await db
    .select({ id: mentorPairings.id })
    .from(mentorPairings)
    .where(and(eq(mentorPairings.mentorId, mentorId), eq(mentorPairings.teacherId, id)))
    .limit(1);
  return Boolean(row);
}
