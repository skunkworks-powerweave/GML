// Wiki data layer — replaces the JSX prototype's `window.wikiLookup` map
// (LMS GML Frontend/wiki-data.jsx lines 200-211) with real, request-cached
// Drizzle queries against the production schema. Returns display-safe fields
// only (no PII columns — SM-9 holds without an explicit audit hook).
//
// Used by every cross-entity RelLink rendered in /repo/* routes.

import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  schools,
  subjects,
  teachers,
  classes,
  sessions,
  courseOutlines,
  mentors,
  resources,
} from "@gml/db/schema";

export type WikiKind =
  | "school"
  | "subject"
  | "teacher"
  | "class"
  | "session"
  | "outline"
  | "mentor"
  | "resource";

export type WikiSchool = {
  id: string;
  code: string;
  name: string;
};

export type WikiSubject = {
  id: string;
  name: string;
  code: string;
  color: string | null;
};

export type WikiTeacher = {
  id: string;
  fullName: string;
  hindiName: string | null;
  schoolId: string;
  subjectSpecialism: string | null;
};

export type WikiClass = {
  id: string;
  schoolId: string;
  grade: number;
  stage: string;
  studentsCount: number;
  sectionsCount: number;
  classTeacherName: string | null;
};

export type WikiSession = {
  id: string;
  schoolId: string;
  classId: string;
  subjectId: string;
  teacherId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  topic: string | null;
  status: string;
  attendedCount: number;
  totalCount: number;
  observed: boolean;
  subjectName: string | null;
  schoolCode: string | null;
  schoolName: string | null;
  teacherName: string | null;
};

export type WikiOutline = {
  id: string;
  subjectId: string;
  grade: number;
  term: number;
  name: string;
  weeks: number | null;
  sessionsCount: number;
  status: string;
  ownerTeacherId: string | null;
};

export type WikiMentor = {
  id: string;
  name: string;
  hindiName: string | null;
  baseLocation: string | null;
};

export type WikiResource = {
  id: string;
  name: string;
  kind: string;
  owner: string | null;
  pages: number | null;
};

// ---------------------------------------------------------------------------
// Lookup helpers — each wrapped in React.cache for per-render deduplication.
// ---------------------------------------------------------------------------

const lookupSchool = cache(async (id: string): Promise<WikiSchool | null> => {
  if (!id) return null;
  const [row] = await db
    .select({ id: schools.id, code: schools.code, name: schools.name })
    .from(schools)
    .where(eq(schools.id, id))
    .limit(1);
  return row ?? null;
});

const lookupSubject = cache(async (id: string): Promise<WikiSubject | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      code: subjects.code,
      color: subjects.color,
    })
    .from(subjects)
    .where(eq(subjects.id, id))
    .limit(1);
  return row ?? null;
});

const lookupTeacher = cache(async (id: string): Promise<WikiTeacher | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: teachers.id,
      fullName: teachers.fullName,
      hindiName: teachers.hindiName,
      schoolId: teachers.schoolId,
      subjectSpecialism: teachers.subjectSpecialism,
    })
    .from(teachers)
    .where(eq(teachers.id, id))
    .limit(1);
  return row ?? null;
});

const lookupClass = cache(async (id: string): Promise<WikiClass | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: classes.id,
      schoolId: classes.schoolId,
      grade: classes.grade,
      stage: classes.stage,
      studentsCount: classes.studentsCount,
      sectionsCount: classes.sectionsCount,
      classTeacherName: classes.classTeacherName,
    })
    .from(classes)
    .where(eq(classes.id, id))
    .limit(1);
  return row ?? null;
});

const lookupSession = cache(async (id: string): Promise<WikiSession | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: sessions.id,
      schoolId: sessions.schoolId,
      classId: sessions.classId,
      subjectId: sessions.subjectId,
      teacherId: sessions.teacherId,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      attendedCount: sessions.attendedCount,
      totalCount: sessions.totalCount,
      observed: sessions.observed,
      subjectName: subjects.name,
      schoolCode: schools.code,
      schoolName: schools.name,
      teacherName: teachers.fullName,
    })
    .from(sessions)
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(schools, eq(sessions.schoolId, schools.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
});

const lookupOutline = cache(async (id: string): Promise<WikiOutline | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: courseOutlines.id,
      subjectId: courseOutlines.subjectId,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      name: courseOutlines.name,
      weeks: courseOutlines.weeks,
      sessionsCount: courseOutlines.sessionsCount,
      status: courseOutlines.status,
      ownerTeacherId: courseOutlines.ownerTeacherId,
    })
    .from(courseOutlines)
    .where(eq(courseOutlines.id, id))
    .limit(1);
  return row ?? null;
});

const lookupMentor = cache(async (id: string): Promise<WikiMentor | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: mentors.id,
      name: mentors.name,
      hindiName: mentors.hindiName,
      baseLocation: mentors.baseLocation,
    })
    .from(mentors)
    .where(eq(mentors.id, id))
    .limit(1);
  return row ?? null;
});

const lookupResource = cache(async (id: string): Promise<WikiResource | null> => {
  if (!id) return null;
  const [row] = await db
    .select({
      id: resources.id,
      name: resources.name,
      kind: resources.kind,
      owner: resources.owner,
      pages: resources.pages,
    })
    .from(resources)
    .where(eq(resources.id, id))
    .limit(1);
  return row ?? null;
});

/**
 * Cross-entity lookup helper. Mirrors `window.wikiLookup` from the JSX
 * prototype (LMS GML Frontend/wiki-data.jsx lines 200-211) but each method
 * returns a Promise resolved against the live Drizzle schema.
 *
 * Within a single render pass, repeat calls for the same id are deduped via
 * React.cache — so calling `wikiLookup.school(x)` twice issues one SQL query.
 */
export const wikiLookup = {
  school: lookupSchool,
  subject: lookupSubject,
  teacher: lookupTeacher,
  class: lookupClass,
  session: lookupSession,
  outline: lookupOutline,
  mentor: lookupMentor,
  resource: lookupResource,
};

/**
 * Maps an entity kind + id to its canonical /repo/<kind>/<id> URL. Mirrors
 * the JSX prototype's `onNavigate(`${kind}/${id}`)` convention used by
 * RepoRouter (repository.jsx lines 1081-1089).
 */
export function hrefForEntity(kind: WikiKind, id: string): string {
  return `/repo/${kind}/${id}`;
}

/**
 * Maps a subjects.color string (or a generic kind) to a {bg, ink} pair of
 * CSS variable tokens. Mirrors `subjectColor()` from repository.jsx lines
 * 11-16 plus the kind→color mapping in the wiki spec.
 */
export function chipColorFor(
  kind: WikiKind,
  subjectColor?: string | null,
): { bg: string; ink: string } {
  if (kind === "subject" && subjectColor) {
    switch (subjectColor) {
      case "blue":
      case "purple":
        return { bg: "var(--indigo-soft)", ink: "var(--indigo)" };
      case "green":
        return { bg: "var(--lichen-soft)", ink: "var(--lichen)" };
      case "orange":
      case "yellow":
      case "brown":
        return { bg: "var(--saffron-soft)", ink: "var(--saffron)" };
      case "red":
      case "pink":
        return { bg: "var(--rust-soft)", ink: "var(--rust)" };
      default:
        return { bg: "var(--paper-2)", ink: "var(--ink-2)" };
    }
  }
  switch (kind) {
    case "school":
    case "class":
    case "outline":
      return { bg: "var(--indigo-soft)", ink: "var(--indigo)" };
    case "session":
      return { bg: "var(--saffron-soft)", ink: "var(--saffron)" };
    case "mentor":
      return { bg: "var(--rust-soft)", ink: "var(--rust)" };
    case "subject":
      return { bg: "var(--lichen-soft)", ink: "var(--lichen)" };
    case "teacher":
    case "resource":
    default:
      return { bg: "var(--paper-2)", ink: "var(--ink-2)" };
  }
}
