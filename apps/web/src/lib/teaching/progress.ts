import "server-only";

// Student progress: how the students of a class are doing, in numbers a
// teacher and a programme admin both read.
//
//   per student   sessions attended / marked, attendance %, average marks, the
//                 date of the last session she was marked in
//   per class     active students, sessions held / planned, attendance rate,
//                 average marks
//   per school    the same, over its classes (the admin overview)
//
// ONE DEFINITION. Attendance % is what the roster already stores
// (./records.ts refreshLearnerAttendance): present and late over every session
// the student was marked in that was not cancelled, rounded to a whole number;
// a student never marked has none (NULL), not 0 -- unless a percentage was typed
// on the student list (the grid or a CSV, learners.attendance_pct), which is then
// shown as such, so what an administrator uploaded appears here too. A student
// who has been marked is always worked out from the marks. A class's rate pools
// its students' marks (attended / marked), so a student marked in many sessions
// weighs more than one marked in few; it counts marked sessions only. Average
// marks follow lib/grading/summary: each recorded mark as a percentage of its
// test's maximum, absent and blank left out, one decimal. A record still
// awaiting approval counts, as the design says reports do.
//
// WHO IS COUNTED. The students of a class are its roster (./index.ts roster):
// active, not deleted, and for a teacher linked to one section that section's
// and those with none. A teacher's figures count HER sessions and HER tests
// only (as every other record of hers does -- lib/teaching/visibility.ts); an
// admin's count every teacher's. Only sessions and tests of the student's own
// class count towards that class.
//
// Aggregated in SQL, grouped by student or by class: the number of queries
// does not grow with the number of students, sessions or schools.

import { and, asc, count, eq, inArray, isNotNull, isNull, max, ne, or, sql } from "drizzle-orm";
import { assessmentMarks, assessments, classes, districts, learners, schools, sessionAttendance, sessions, zones } from "@gml/db/schema";
import type { Db } from "@/lib/visibility";
import { schoolsIn, type Place } from "@/lib/rtt/scope";
import { roster } from "./index";
import { ATTENDED } from "./records";

/** A student below this attendance % is highlighted (the repository's class roster colours it the same). */
export const LOW_ATTENDANCE_PCT = 75;

/** Schools per page of the admin overview. */
export const SCHOOLS_PER_PAGE = 25;

/** Present or late over everything she was marked in; null when she was never marked. */
export function attendancePercent(attended: number, marked: number): number | null {
  return marked > 0 ? Math.round((100 * attended) / marked) : null;
}

export const isLowAttendance = (pct: number | null): boolean => pct != null && pct < LOW_ATTENDANCE_PCT;

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;
const averageOf = (sum: number, n: number): number | null => (n > 0 ? oneDecimal(sum / n) : null);

export type StudentProgress = {
  id: string;
  name: string;
  rollNumber: string | null;
  section: string | null;
  /** Sessions she was marked in (cancelled ones left out). */
  marked: number;
  /** Of those, the ones she was present or late for. */
  attended: number;
  attendancePct: number | null;
  /** The percentage is the one typed on the student list: no session has been marked for her. */
  pctFromRoster: boolean;
  /** Marks recorded for her (absent and blank left out). */
  marksCount: number;
  marksAvg: number | null;
  /** "YYYY-MM-DD" of the last session she was marked in. */
  lastSession: string | null;
  low: boolean;
};

export type ClassFigures = {
  students: number;
  sessionsHeld: number;
  /** Held and still to come: every session that was not cancelled. */
  sessionsPlanned: number;
  marked: number;
  attended: number;
  attendancePct: number | null;
  marksCount: number;
  /** The recorded marks as percentages, summed: what lets a school pool its classes. */
  marksSum: number;
  marksAvg: number | null;
};

function figuresOf(f: Pick<ClassFigures, "students" | "sessionsHeld" | "sessionsPlanned" | "marked" | "attended" | "marksCount" | "marksSum">): ClassFigures {
  return { ...f, attendancePct: attendancePercent(f.attended, f.marked), marksAvg: averageOf(f.marksSum, f.marksCount) };
}

/** The figures of several classes together (a school). */
export function sumFigures(all: readonly ClassFigures[]): ClassFigures {
  const total = { students: 0, sessionsHeld: 0, sessionsPlanned: 0, marked: 0, attended: 0, marksCount: 0, marksSum: 0 };
  for (const f of all) for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += f[k];
  return figuresOf(total);
}

// ── Fragments: the definitions, written once ─────────────────────────────────

/** A session counts towards attendance unless it was cancelled. */
const counted = ne(sessions.status, "cancelled");
const attendedStatus = inArray(sessionAttendance.status, [...ATTENDED]);
const attendedCount = sql<number>`count(*) filter (where ${attendedStatus})`.mapWith(Number);

/** A mark as a percentage of its test's maximum. */
const markPct = sql`100.0 * ${assessmentMarks.marks} / ${assessments.maxMarks}`;
const recordedMark = and(eq(assessmentMarks.absent, false), isNotNull(assessmentMarks.marks));
const markSum = sql<number>`coalesce(sum(${markPct}), 0)`.mapWith(Number);

/** Her sessions and tests only, or every teacher's when no teacher is named. */
const ownSession = (teacherId?: string | null) => (teacherId ? eq(sessions.teacherId, teacherId) : undefined);
const ownTest = (teacherId?: string | null) => (teacherId ? eq(assessments.teacherId, teacherId) : undefined);

/** roster()'s rule, for a query over many classes: active, not deleted, and of the section (or of none). */
const onRoster = (section: string | null) =>
  and(eq(learners.active, true), isNull(learners.deletedAt), section ? or(isNull(learners.section), eq(learners.section, section)) : undefined);

/** A teacher's link to one section teaches that section's sessions and the whole grade's. */
const sectionSessions = (section: string | null) => (section ? or(isNull(sessions.section), eq(sessions.section, section)) : undefined);

export type Scope = {
  classId: string;
  /** The section she teaches; null or absent is the whole grade. */
  section?: string | null;
  /** Her sessions and tests only; absent is every teacher's. */
  teacherId?: string | null;
};

// ── Per student ──────────────────────────────────────────────────────────────

/** The students of a class (as the roster lists them, in roster order) with their figures. */
export async function studentProgress(db: Db, q: Scope): Promise<StudentProgress[]> {
  const students = await roster(db, q.classId, q.section ?? null);
  if (students.length === 0) return [];
  const ids = students.map((s) => s.id);

  const [typed, attendance, marks] = await Promise.all([
    db.select({ id: learners.id, pct: learners.attendancePct }).from(learners).where(inArray(learners.id, ids)),
    db
      .select({ learnerId: sessionAttendance.learnerId, marked: count(), attended: attendedCount, last: max(sessions.scheduledDate) })
      .from(sessionAttendance)
      .innerJoin(sessions, eq(sessions.id, sessionAttendance.sessionId))
      .where(and(inArray(sessionAttendance.learnerId, ids), eq(sessions.classId, q.classId), counted, ownSession(q.teacherId)))
      .groupBy(sessionAttendance.learnerId),
    db
      .select({ learnerId: assessmentMarks.learnerId, graded: count(), sum: markSum })
      .from(assessmentMarks)
      .innerJoin(assessments, eq(assessments.id, assessmentMarks.assessmentId))
      .where(and(inArray(assessmentMarks.learnerId, ids), eq(assessments.classId, q.classId), recordedMark, ownTest(q.teacherId)))
      .groupBy(assessmentMarks.learnerId),
  ]);
  const typedOf = new Map(typed.map((r) => [r.id, r.pct]));
  const attendanceOf = new Map(attendance.map((r) => [r.learnerId, r]));
  const marksOf = new Map(marks.map((r) => [r.learnerId, r]));

  return students.map((s) => {
    const a = attendanceOf.get(s.id);
    const m = marksOf.get(s.id);
    const marked = a?.marked ?? 0;
    const attended = a?.attended ?? 0;
    const fromRoster = marked === 0 && typedOf.get(s.id) != null;
    const pct = fromRoster ? (typedOf.get(s.id) ?? null) : attendancePercent(attended, marked);
    return {
      id: s.id,
      name: s.name,
      rollNumber: s.rollNumber,
      section: s.section,
      marked,
      attended,
      attendancePct: pct,
      pctFromRoster: fromRoster,
      marksCount: m?.graded ?? 0,
      marksAvg: m ? averageOf(m.sum, m.graded) : null,
      lastSession: a?.last ?? null,
      low: isLowAttendance(pct),
    };
  });
}

export type StudentOrder = "roll" | "attendance";

/** The order a page was asked for (?sort=); anything else is the roster's. */
export const parseOrder = (raw: unknown): StudentOrder => (raw === "attendance" ? "attendance" : "roll");

/** Roster order, or lowest attendance first with the never-marked last; ties keep roster order. */
export function sortStudents<T extends { attendancePct: number | null }>(rows: readonly T[], by: StudentOrder): T[] {
  if (by !== "attendance") return [...rows];
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => (a.attendancePct ?? Infinity) - (b.attendancePct ?? Infinity) || i - j)
    .map(([r]) => r);
}

// ── Per class ────────────────────────────────────────────────────────────────

/**
 * The figures of each of these classes: four grouped queries, whatever the
 * number of classes. Restricted, when given, to a section's students and sessions
 * and to one teacher's sessions and tests.
 */
export async function classFigures(
  db: Db,
  q: { classIds: string[]; section?: string | null; teacherId?: string | null },
): Promise<Map<string, ClassFigures>> {
  const out = new Map<string, ClassFigures>();
  if (q.classIds.length === 0) return out;
  const section = q.section ?? null;

  const [students, held, attendance, marks] = await Promise.all([
    db
      .select({ classId: learners.classId, n: count() })
      .from(learners)
      .where(and(inArray(learners.classId, q.classIds), onRoster(section)))
      .groupBy(learners.classId),
    db
      .select({
        classId: sessions.classId,
        held: sql<number>`count(*) filter (where ${eq(sessions.status, "complete")})`.mapWith(Number),
        planned: sql<number>`count(*) filter (where ${counted})`.mapWith(Number),
      })
      .from(sessions)
      .where(and(inArray(sessions.classId, q.classIds), ownSession(q.teacherId), sectionSessions(section)))
      .groupBy(sessions.classId),
    db
      .select({ classId: sessions.classId, marked: count(), attended: attendedCount })
      .from(sessionAttendance)
      .innerJoin(sessions, eq(sessions.id, sessionAttendance.sessionId))
      .innerJoin(learners, and(eq(learners.id, sessionAttendance.learnerId), eq(learners.classId, sessions.classId)))
      .where(and(inArray(sessions.classId, q.classIds), counted, ownSession(q.teacherId), onRoster(section)))
      .groupBy(sessions.classId),
    db
      .select({ classId: assessments.classId, graded: count(), sum: markSum })
      .from(assessmentMarks)
      .innerJoin(assessments, eq(assessments.id, assessmentMarks.assessmentId))
      .innerJoin(learners, and(eq(learners.id, assessmentMarks.learnerId), eq(learners.classId, assessments.classId)))
      .where(and(inArray(assessments.classId, q.classIds), recordedMark, ownTest(q.teacherId), onRoster(section)))
      .groupBy(assessments.classId),
  ]);

  const byClass = <R extends { classId: string }>(rows: R[]) => new Map(rows.map((r) => [r.classId, r]));
  const [stu, ses, att, mk] = [byClass(students), byClass(held), byClass(attendance), byClass(marks)];
  for (const classId of q.classIds) {
    out.set(
      classId,
      figuresOf({
        students: stu.get(classId)?.n ?? 0,
        sessionsHeld: ses.get(classId)?.held ?? 0,
        sessionsPlanned: ses.get(classId)?.planned ?? 0,
        marked: att.get(classId)?.marked ?? 0,
        attended: att.get(classId)?.attended ?? 0,
        marksCount: mk.get(classId)?.graded ?? 0,
        marksSum: mk.get(classId)?.sum ?? 0,
      }),
    );
  }
  return out;
}

/** One class: its students and its figures, from the same definitions. */
export async function classProgress(db: Db, q: Scope) {
  const [students, figures] = await Promise.all([
    studentProgress(db, q),
    classFigures(db, { classIds: [q.classId], section: q.section, teacherId: q.teacherId }),
  ]);
  return { students, figures: figures.get(q.classId)!, lowCount: students.filter((s) => s.low).length };
}

// ── The programme ────────────────────────────────────────────────────────────

/** Active schools in the place, by name: the overview's school filter. */
export async function schoolChoices(db: Db, place: Place | null) {
  return db
    .select({ id: schools.id, name: schools.name })
    .from(schools)
    .where(and(eq(schools.active, true), schoolsIn(place)))
    .orderBy(asc(schools.name), asc(schools.id));
}

export type SchoolProgress = {
  id: string;
  name: string;
  code: string;
  districtName: string;
  zoneName: string;
  classes: Array<{ classId: string; grade: number; stage: string; figures: ClassFigures }>;
  totals: ClassFigures;
};

/**
 * Active schools, a page at a time, with their active classes and the figures
 * of each: for the admin overview. `place` (a district, or a zone of it) and
 * `schoolId` narrow it; a page past the end answers with the last one.
 */
export async function programmeProgress(
  db: Db,
  q: { place?: Place | null; schoolId?: string | null; page?: number; pageSize?: number } = {},
) {
  const pageSize = q.pageSize ?? SCHOOLS_PER_PAGE;
  const where = and(eq(schools.active, true), schoolsIn(q.place ?? null), q.schoolId ? eq(schools.id, q.schoolId) : undefined);

  const [{ n: total } = { n: 0 }] = await db.select({ n: count() }).from(schools).where(where);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(q.page ?? 1)), pages);

  const rows = await db
    .select({ id: schools.id, name: schools.name, code: schools.code, districtName: districts.name, zoneName: zones.name })
    .from(schools)
    .innerJoin(zones, eq(zones.id, schools.zoneId))
    .innerJoin(districts, eq(districts.id, zones.districtId))
    .where(where)
    .orderBy(asc(districts.name), asc(zones.name), asc(schools.name), asc(schools.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const schoolIds = rows.map((r) => r.id);
  const classRows = schoolIds.length
    ? await db
        .select({ id: classes.id, schoolId: classes.schoolId, grade: classes.grade, stage: classes.stage })
        .from(classes)
        .where(and(inArray(classes.schoolId, schoolIds), eq(classes.active, true)))
        .orderBy(asc(classes.grade))
    : [];
  const figures = await classFigures(db, { classIds: classRows.map((c) => c.id) });

  const schoolsOut: SchoolProgress[] = rows.map((s) => {
    const mine = classRows
      .filter((c) => c.schoolId === s.id)
      .map((c) => ({ classId: c.id, grade: c.grade, stage: c.stage, figures: figures.get(c.id)! }));
    return { ...s, classes: mine, totals: sumFigures(mine.map((c) => c.figures)) };
  });
  return { total, page, pages, pageSize, schools: schoolsOut };
}
