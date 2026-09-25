// RTT progress: what a learner has done (lessons and readings she marked done,
// quizzes she passed, sessions she was marked present at), and the staff view
// of quiz results and attendance.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Nothing recorded or showed any of it. There was no completion table, the
// subject page's "Resume" always jumped to module 1, a teacher never saw her
// own attendance, and quiz_submissions / rtt_attendance were read by nothing a
// programme admin or mentor could open: who sat, passed or attended was
// answerable only in SQL. rtt_progress (migration 0037) holds the completions;
// the rest was already recorded and only needed reading.
//
// Completion is SELF-REPORTED -- the learner ticks a lesson or reading done. It
// is a place-keeper for her and a signal for staff, not evidence; quiz results
// and attendance are the recorded outcomes, and the staff view shows those.
//
// Takes the database as a parameter so the behaviour suite can run it.

import { and, asc, count, desc, eq, inArray, max, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  phases,
  quizSubmissions,
  quizzes,
  rttAttendance,
  rttLessons,
  rttModules,
  rttProgress,
  rttReadings,
  rttSessions,
  rttSubjects,
  schools,
  teachers,
  terms,
} from "@gml/db/schema";

type Db = NodePgDatabase<Record<string, unknown>>;

/** The lessons and readings (of those given) `userId` has marked done. */
export async function doneItems(
  db: Db,
  userId: string,
  lessonIds: string[],
  readingIds: string[],
): Promise<{ lessons: Set<string>; readings: Set<string> }> {
  const clauses: SQL[] = [];
  if (lessonIds.length) clauses.push(inArray(rttProgress.rttLessonId, lessonIds));
  if (readingIds.length) clauses.push(inArray(rttProgress.rttReadingId, readingIds));
  const lessons = new Set<string>();
  const readings = new Set<string>();
  if (clauses.length === 0) return { lessons, readings };
  const rows = await db
    .select({ lessonId: rttProgress.rttLessonId, readingId: rttProgress.rttReadingId })
    .from(rttProgress)
    .where(and(eq(rttProgress.userId, userId), or(...clauses)));
  for (const r of rows) {
    if (r.lessonId) lessons.add(r.lessonId);
    if (r.readingId) readings.add(r.readingId);
  }
  return { lessons, readings };
}

export type AttendanceStatus = "present" | "absent" | "excused";

/**
 * `userId`'s attendance on the given sessions, through her teachers row. A
 * login with no teachers row has none: attendance is taken of teachers.
 */
export async function attendanceOf(
  db: Db,
  userId: string,
  sessionIds: string[],
): Promise<Map<string, AttendanceStatus>> {
  const out = new Map<string, AttendanceStatus>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({ sessionId: rttAttendance.rttSessionId, status: rttAttendance.status })
    .from(rttAttendance)
    .innerJoin(teachers, eq(teachers.id, rttAttendance.teacherId))
    .where(and(eq(teachers.userId, userId), inArray(rttAttendance.rttSessionId, sessionIds)));
  for (const r of rows) out.set(r.sessionId, r.status);
  return out;
}

/**
 * Where "Resume" goes: the first module, in teaching order, with a lesson not
 * yet done. A subject with no lessons, or with all of them done, resumes at its
 * first module; one with no modules, at the modules card.
 */
export function resumeModule<M extends { id: string; sequence: number }>(
  modules: M[],
  lessonsByModule: Map<string, Array<{ id: string }>>,
  done: Set<string>,
): M | null {
  const next = modules.find((m) => (lessonsByModule.get(m.id) ?? []).some((l) => !done.has(l.id)));
  return next ?? modules[0] ?? null;
}

export type SubjectProgressRow = {
  subjectId: string;
  subjectName: string;
  termName: string;
  phaseLabel: string;
  lessonsDone: number;
  lessonsTotal: number;
  readingsDone: number;
  readingsTotal: number;
  quizzesPassed: number;
  quizzesTotal: number;
  sessionsPresent: number;
  /** Sessions her attendance was taken at. */
  sessionsMarked: number;
};

const int = (q: SQL) => sql<number>`(${q})::int`;

/** One learner's progress in each subject `subjectWhere` admits. */
export async function progressBySubject(db: Db, userId: string, subjectWhere?: SQL): Promise<SubjectProgressRow[]> {
  const s = rttSubjects.id;
  return db
    .select({
      subjectId: rttSubjects.id,
      subjectName: rttSubjects.name,
      termName: terms.name,
      phaseLabel: phases.label,
      lessonsDone: int(sql`SELECT count(*) FROM ${rttProgress}
        JOIN ${rttLessons} ON ${rttLessons.id} = ${rttProgress.rttLessonId}
        JOIN ${rttModules} ON ${rttModules.id} = ${rttLessons.rttModuleId}
        WHERE ${rttModules.rttSubjectId} = ${s} AND ${rttProgress.userId} = ${userId}`),
      lessonsTotal: int(sql`SELECT count(*) FROM ${rttLessons}
        JOIN ${rttModules} ON ${rttModules.id} = ${rttLessons.rttModuleId}
        WHERE ${rttModules.rttSubjectId} = ${s}`),
      readingsDone: int(sql`SELECT count(*) FROM ${rttProgress}
        JOIN ${rttReadings} ON ${rttReadings.id} = ${rttProgress.rttReadingId}
        WHERE ${rttReadings.rttSubjectId} = ${s} AND ${rttProgress.userId} = ${userId}`),
      readingsTotal: int(sql`SELECT count(*) FROM ${rttReadings} WHERE ${rttReadings.rttSubjectId} = ${s}`),
      quizzesPassed: int(sql`SELECT count(DISTINCT ${quizzes.id}) FROM ${quizzes}
        JOIN ${quizSubmissions} ON ${quizSubmissions.quizId} = ${quizzes.id}
        WHERE ${quizzes.rttSubjectId} = ${s} AND ${quizzes.active}
          AND ${quizSubmissions.userId} = ${userId} AND ${quizSubmissions.passed}`),
      quizzesTotal: int(sql`SELECT count(*) FROM ${quizzes} WHERE ${quizzes.rttSubjectId} = ${s} AND ${quizzes.active}`),
      sessionsPresent: int(sql`SELECT count(*) FROM ${rttAttendance}
        JOIN ${rttSessions} ON ${rttSessions.id} = ${rttAttendance.rttSessionId}
        JOIN ${teachers} ON ${teachers.id} = ${rttAttendance.teacherId}
        WHERE ${rttSessions.rttSubjectId} = ${s} AND ${teachers.userId} = ${userId}
          AND ${rttAttendance.status} = 'present'`),
      sessionsMarked: int(sql`SELECT count(*) FROM ${rttAttendance}
        JOIN ${rttSessions} ON ${rttSessions.id} = ${rttAttendance.rttSessionId}
        JOIN ${teachers} ON ${teachers.id} = ${rttAttendance.teacherId}
        WHERE ${rttSessions.rttSubjectId} = ${s} AND ${teachers.userId} = ${userId}`),
    })
    .from(rttSubjects)
    .innerJoin(terms, eq(terms.id, rttSubjects.termId))
    .innerJoin(phases, eq(phases.id, terms.phaseId))
    .where(subjectWhere)
    .orderBy(asc(phases.sequence), asc(terms.sequence), asc(rttSubjects.name));
}

// ── staff view ───────────────────────────────────────────────────────────────

/** How many rows a staff table shows before it asks for a narrower filter. */
export const STAFF_ROW_LIMIT = 200;

export type StaffFilter = {
  /** teachers.id values the viewer may see; null means every teacher. */
  teacherIds: string[] | null;
  subjectId: string | null;
  /** A district / zone filter on the teachers (lib/rtt/scope.ts teachersIn). */
  teachersWhere?: SQL;
};

function teacherScope(f: StaffFilter): SQL | undefined {
  // An empty list must match nothing, not everything (lib/visibility.ts).
  const allowed = f.teacherIds === null ? undefined : f.teacherIds.length ? inArray(teachers.id, f.teacherIds) : sql`false`;
  return and(allowed, f.teachersWhere);
}

export type QuizResultRow = {
  teacherId: string;
  teacherName: string;
  schoolName: string;
  quizTitle: string;
  quizSlug: string;
  subjectName: string;
  attempts: number;
  bestScore: number;
  passed: boolean;
  lastAt: Date;
};

/** Each teacher's record on each RTT quiz: attempts, best score, passed. */
export async function quizResults(db: Db, f: StaffFilter): Promise<{ rows: QuizResultRow[]; more: boolean }> {
  const rows = await db
    .select({
      teacherId: teachers.id,
      teacherName: teachers.fullName,
      schoolName: schools.name,
      quizTitle: quizzes.title,
      quizSlug: quizzes.slug,
      subjectName: rttSubjects.name,
      attempts: count(),
      bestScore: sql<number>`max(${quizSubmissions.score})::int`,
      passed: sql<boolean>`bool_or(${quizSubmissions.passed})`,
      lastAt: max(quizSubmissions.submittedAt),
    })
    .from(quizSubmissions)
    .innerJoin(quizzes, eq(quizzes.id, quizSubmissions.quizId))
    .innerJoin(rttSubjects, eq(rttSubjects.id, quizzes.rttSubjectId))
    .innerJoin(teachers, eq(teachers.userId, quizSubmissions.userId))
    .innerJoin(schools, eq(schools.id, teachers.schoolId))
    .where(and(teacherScope(f), f.subjectId ? eq(rttSubjects.id, f.subjectId) : undefined))
    .groupBy(teachers.id, teachers.fullName, schools.name, quizzes.id, quizzes.title, quizzes.slug, rttSubjects.name)
    .orderBy(asc(teachers.fullName), asc(rttSubjects.name), asc(quizzes.title))
    .limit(STAFF_ROW_LIMIT + 1);
  return {
    rows: rows.slice(0, STAFF_ROW_LIMIT).map((r) => ({ ...r, lastAt: r.lastAt ?? new Date(0) })),
    more: rows.length > STAFF_ROW_LIMIT,
  };
}

export type AttendanceRow = {
  teacherName: string;
  schoolName: string;
  sessionTitle: string;
  subjectName: string;
  scheduledAt: Date | null;
  status: AttendanceStatus;
};

/** Attendance taken at RTT sessions, newest session first. */
export async function attendanceRows(db: Db, f: StaffFilter): Promise<{ rows: AttendanceRow[]; more: boolean }> {
  const rows = await db
    .select({
      teacherName: teachers.fullName,
      schoolName: schools.name,
      sessionTitle: rttSessions.title,
      subjectName: rttSubjects.name,
      scheduledAt: rttSessions.scheduledAt,
      status: rttAttendance.status,
    })
    .from(rttAttendance)
    .innerJoin(rttSessions, eq(rttSessions.id, rttAttendance.rttSessionId))
    .innerJoin(rttSubjects, eq(rttSubjects.id, rttSessions.rttSubjectId))
    .innerJoin(teachers, eq(teachers.id, rttAttendance.teacherId))
    .innerJoin(schools, eq(schools.id, teachers.schoolId))
    .where(and(teacherScope(f), f.subjectId ? eq(rttSubjects.id, f.subjectId) : undefined))
    .orderBy(sql`${rttSessions.scheduledAt} DESC NULLS LAST`, asc(teachers.fullName), desc(rttAttendance.markedAt))
    .limit(STAFF_ROW_LIMIT + 1);
  return { rows: rows.slice(0, STAFF_ROW_LIMIT), more: rows.length > STAFF_ROW_LIMIT };
}
