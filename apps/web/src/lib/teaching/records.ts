import "server-only";

// The teacher's own records, beyond the ownership rules in ./index.ts: the
// queries and writes the /teaching pages and their server actions share.
//
//   parsing        a grade, a section, a date, a time, a whole number, from a
//                  form field -- one definition, so the class form and the
//                  student form cannot disagree about what "section" means
//   ensureClass    the school's classes row for a grade, created if missing
//   linkOf /       a class link or a student that is hers (null otherwise):
//   studentOf      every write starts from one of these
//   hub            her counts and what came back from an approver
//   attendance     saving a session's attendance recomputes the session's
//                  attended / total counts and each student's attendance %
//
// Every function takes the database handle, so the behaviour tests run them
// against Postgres. Ownership is decided here and in ./index.ts, never in a
// page's markup. Design: docs/superpowers/specs/2026-09-28-teaching-records-design.md.

import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  approvals,
  assessments,
  classes,
  courseOutlines,
  learners,
  outlineLessons,
  sessionAttendance,
  sessions,
  subjects,
  teacherClasses,
  type ApprovalItemType,
} from "@gml/db/schema";
import type { Db } from "@/lib/visibility";
import type { DbOrTx } from "@/lib/approvals/types";
import { isEditable } from "@/lib/approvals/handlers/records";
import { isUuid } from "@/lib/ids";
import { myClassLinks, ownsSession, roster, type ClassLink } from "./index";

export const SESSION_STATUSES = ["planned", "in_progress", "complete", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ATTENDANCE_STATUSES = ["present", "absent", "late", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** A present or late student attended; absent and excused did not. */
export const ATTENDED: readonly AttendanceStatus[] = ["present", "late"];

/** The programme's timezone: "today" for upcoming / past is India's today. */
export const PROGRAMME_TZ = "Asia/Kolkata";

// ── parsing ──────────────────────────────────────────────────────────────────

export const text = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();

/** An optional whole number in [min, max]: null when blank, NaN when it is not one. */
export function wholeNumber(raw: string, min: number, max: number): number | null {
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const n = Number(raw);
  return n >= min && n <= max ? n : Number.NaN;
}

/**
 * A section as the school writes it: "A", "B", "Rose". Trimmed, upper-cased
 * (a teacher typing "a" means the section the register calls "A"), at most 8
 * characters. null when blank; undefined when it cannot be one.
 */
export function parseSection(raw: string): string | null | undefined {
  const s = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (s === "") return null;
  return s.length <= 8 ? s : undefined;
}

/** A calendar date "YYYY-MM-DD" that exists, or null. */
export function parseDate(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
}

/** A time of day "HH:MM" (seconds allowed and dropped), or null. */
export function parseTime(raw: string): string | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]}:${m[2]}` : null;
}

/** Today in the programme's timezone, as "YYYY-MM-DD". */
export function todayInProgramme(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PROGRAMME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Learning outcomes as typed: one per line, blank lines dropped. */
export function outcomesFrom(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ── classes ──────────────────────────────────────────────────────────────────

/**
 * The stage a grade belongs to, in the values the classes table already holds
 * (the repository's stage chips read Primary / Middle / High).
 */
export function stageForGrade(grade: number): "Primary" | "Middle" | "High" {
  if (grade <= 5) return "Primary";
  if (grade <= 8) return "Middle";
  return "High";
}

/**
 * The school's classes row for `grade`, created when the school has none yet.
 * A class is a school's grade (classes_school_grade_uq), so two teachers
 * adding Grade 5 at the same school share one row; ON CONFLICT makes the race
 * between them harmless.
 */
export async function ensureClass(db: DbOrTx, schoolId: string, grade: number): Promise<{ id: string; created: boolean }> {
  const [made] = await db
    .insert(classes)
    .values({ schoolId, grade, stage: stageForGrade(grade) })
    .onConflictDoNothing({ target: [classes.schoolId, classes.grade] })
    .returning({ id: classes.id });
  if (made) return { id: made.id, created: true };
  const [row] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.schoolId, schoolId), eq(classes.grade, grade)))
    .limit(1);
  return { id: row!.id, created: false };
}

export type HerLink = ClassLink & { subjectName: string | null };

/** Her class links, with the subject's name. */
export async function myLinks(db: Db, teacherId: string): Promise<HerLink[]> {
  const links = await myClassLinks(db, teacherId);
  const subjectIds = [...new Set(links.map((l) => l.subjectId).filter((s): s is string => !!s))];
  const names = new Map<string, string>();
  if (subjectIds.length > 0) {
    for (const s of await db.select({ id: subjects.id, name: subjects.name }).from(subjects).where(inArray(subjects.id, subjectIds))) {
      names.set(s.id, s.name);
    }
  }
  return links.map((l) => ({ ...l, subjectName: l.subjectId ? (names.get(l.subjectId) ?? null) : null }));
}

/** One of her class links, or null (not hers, or no such link). */
export async function linkOf(db: Db, teacherId: string, linkId: string): Promise<ClassLink | null> {
  const links = await myClassLinks(db, teacherId);
  return links.find((l) => l.linkId === linkId) ?? null;
}

/** Active subjects, in the programme's order: the subject choices. */
export async function activeSubjects(db: Db) {
  return db
    .select({ id: subjects.id, name: subjects.name, gradesMin: subjects.gradesMin, gradesMax: subjects.gradesMax })
    .from(subjects)
    .where(eq(subjects.active, true))
    .orderBy(asc(subjects.displayOrder), asc(subjects.name));
}

export async function subjectExists(db: Db, subjectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(and(eq(subjects.id, subjectId), eq(subjects.active, true)))
    .limit(1);
  return !!row;
}

// ── students ─────────────────────────────────────────────────────────────────

/**
 * A student who is hers, with what the forms show, or null. "Hers" is exactly
 * what her roster shows (./index.ts roster): a learner of a class she is
 * linked to, not deleted, and -- when the link names a section -- of that
 * section or of none.
 */
export async function studentOf(db: Db, teacherId: string, learnerId: string) {
  const [row] = await db
    .select({
      id: learners.id,
      classId: learners.classId,
      grade: learners.grade,
      name: learners.name,
      rollNumber: learners.rollNumber,
      section: learners.section,
      age: learners.age,
      guardian: learners.guardian,
    })
    .from(learners)
    // Active too: roster() lists only active students, so an inactive one is
    // on no page of hers and must not be reachable by a hand-made id either.
    .where(and(eq(learners.id, learnerId), isNull(learners.deletedAt), eq(learners.active, true)))
    .limit(1);
  if (!row) return null;
  const links = await db
    .select({ section: teacherClasses.section })
    .from(teacherClasses)
    .where(and(eq(teacherClasses.teacherId, teacherId), eq(teacherClasses.classId, row.classId)));
  const hers = links.some((l) => l.section == null || row.section == null || l.section === row.section);
  return hers ? row : null;
}

export type StudentRow = {
  id: string;
  name: string;
  rollNumber: string | null;
  section: string | null;
  age: number | null;
  guardian: string | null;
};

/** Her students, class link by class link (lowest grade first). */
export async function myStudentsByLink(db: Db, teacherId: string): Promise<Array<{ link: HerLink; students: StudentRow[] }>> {
  const links = await myLinks(db, teacherId);
  const out: Array<{ link: HerLink; students: StudentRow[] }> = [];
  for (const link of links) {
    const ids = (await roster(db, link.classId, link.section)).map((r) => r.id);
    const rows =
      ids.length === 0
        ? []
        : await db
            .select({
              id: learners.id,
              name: learners.name,
              rollNumber: learners.rollNumber,
              section: learners.section,
              age: learners.age,
              guardian: learners.guardian,
            })
            .from(learners)
            .where(inArray(learners.id, ids))
            .orderBy(asc(learners.section), asc(learners.rollNumber), asc(learners.name));
    out.push({ link, students: rows });
  }
  return out;
}

/** How many different students she has (a student in two of her links counts once). */
export async function myStudentCount(db: Db, teacherId: string): Promise<number> {
  const seen = new Set<string>();
  for (const link of await myClassLinks(db, teacherId)) {
    for (const r of await roster(db, link.classId, link.section)) seen.add(r.id);
  }
  return seen.size;
}

// ── lesson plans ─────────────────────────────────────────────────────────────

/** Lesson count of an outline; course_outlines.sessions_count mirrors it for her plans. */
export async function syncSessionsCount(db: DbOrTx, outlineId: string): Promise<number> {
  const [row] = await db.select({ c: count() }).from(outlineLessons).where(eq(outlineLessons.outlineId, outlineId));
  const n = row?.c ?? 0;
  await db.update(courseOutlines).set({ sessionsCount: n, updatedAt: new Date() }).where(eq(courseOutlines.id, outlineId));
  return n;
}

/**
 * Renumber an outline's lessons 1..n in their current order. Two passes, as
 * outline_lessons_outline_sequence_uq is checked row by row: every sequence
 * first moves out of the way, then takes its new number.
 */
export async function renumberLessons(db: DbOrTx, outlineId: string): Promise<void> {
  await db.execute(sql`UPDATE outline_lessons SET sequence = sequence + 100000 WHERE outline_id = ${outlineId}`);
  await db.execute(sql`
    UPDATE outline_lessons AS l SET sequence = o.n
      FROM (SELECT id, row_number() OVER (ORDER BY sequence) AS n FROM outline_lessons WHERE outline_id = ${outlineId}) AS o
     WHERE l.id = o.id`);
}

export type LessonChoice = { id: string; title: string; sequence: number; outlineId: string; outlineName: string; mine: boolean; subjectId: string; grade: number };

/**
 * Lessons she may attach to a session: those of her own plans and of the
 * programme's outlines, for the grades she teaches. The action re-checks the
 * chosen lesson against the session's subject and grade.
 */
export async function lessonChoices(db: Db, teacherId: string, grades: number[]): Promise<LessonChoice[]> {
  if (grades.length === 0) return [];
  const rows = await db
    .select({
      id: outlineLessons.id,
      title: outlineLessons.title,
      sequence: outlineLessons.sequence,
      outlineId: courseOutlines.id,
      outlineName: courseOutlines.name,
      owner: courseOutlines.ownerTeacherId,
      subjectId: courseOutlines.subjectId,
      grade: courseOutlines.grade,
    })
    .from(outlineLessons)
    .innerJoin(courseOutlines, eq(courseOutlines.id, outlineLessons.outlineId))
    .where(
      and(
        inArray(courseOutlines.grade, grades),
        or(eq(courseOutlines.ownerTeacherId, teacherId), and(isNull(courseOutlines.ownerTeacherId), eq(courseOutlines.approvalStatus, "approved"))),
      ),
    )
    .orderBy(asc(courseOutlines.grade), asc(courseOutlines.name), asc(outlineLessons.sequence));
  return rows.map(({ owner, ...r }) => ({ ...r, mine: owner === teacherId }));
}

/**
 * May a session of this subject and grade use `lessonId`? Only a lesson of
 * her own plan or of a programme outline, for the same subject and grade.
 */
export async function lessonFits(db: Db, teacherId: string, lessonId: string, subjectId: string, grade: number): Promise<boolean> {
  const [row] = await db
    .select({ owner: courseOutlines.ownerTeacherId, state: courseOutlines.approvalStatus, subjectId: courseOutlines.subjectId, grade: courseOutlines.grade })
    .from(outlineLessons)
    .innerJoin(courseOutlines, eq(courseOutlines.id, outlineLessons.outlineId))
    .where(eq(outlineLessons.id, lessonId))
    .limit(1);
  if (!row) return false;
  const allowed = row.owner === teacherId || (row.owner === null && row.state === "approved");
  return allowed && row.subjectId === subjectId && row.grade === grade;
}

// ── locking ──────────────────────────────────────────────────────────────────

/**
 * Inside a write's transaction: lock her session's (or plan's) row and confirm
 * it may still change. The actions check isEditable before they start; this
 * closes the moment between that check and the write, in which a submission
 * (lib/approvals onSubmit updates the same row) could make it pending. A
 * submission that comes second waits for the lock, so the approver always
 * sees what was sent.
 */
export async function lockEditableSession(tx: DbOrTx, sessionId: string): Promise<boolean> {
  const [row] = await tx.select({ state: sessions.approvalStatus }).from(sessions).where(eq(sessions.id, sessionId)).for("update");
  return !!row && isEditable(row.state);
}

/**
 * Her session named by `id`, while she may still change it: its row, or why
 * not -- "notFound" (no such session, or not hers: answered the same, so a
 * colleague's id tells her nothing) or "locked" (pending approval, or
 * approved). Every write on a session starts here.
 */
export async function editableSessionOf(
  db: Db,
  teacherId: string,
  id: string,
): Promise<{ id: string; classId: string; section: string | null; status: string } | "notFound" | "locked"> {
  if (!isUuid(id) || !(await ownsSession(db, teacherId, id))) return "notFound";
  const [row] = await db
    .select({ id: sessions.id, classId: sessions.classId, section: sessions.section, status: sessions.status, state: sessions.approvalStatus })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row) return "notFound";
  if (!isEditable(row.state)) return "locked";
  return { id: row.id, classId: row.classId, section: row.section, status: row.status };
}

export async function lockEditablePlan(tx: DbOrTx, outlineId: string): Promise<boolean> {
  const [row] = await tx
    .select({ state: courseOutlines.approvalStatus })
    .from(courseOutlines)
    .where(eq(courseOutlines.id, outlineId))
    .for("update");
  return !!row && isEditable(row.state);
}

// ── attendance ───────────────────────────────────────────────────────────────

/**
 * A session's counts, from its attendance: total = students marked, attended
 * = present + late. Written onto the session in the caller's transaction.
 */
export async function recomputeSessionCounts(tx: DbOrTx, sessionId: string): Promise<{ attended: number; total: number }> {
  const rows = await tx
    .select({ status: sessionAttendance.status, c: count() })
    .from(sessionAttendance)
    .where(eq(sessionAttendance.sessionId, sessionId))
    .groupBy(sessionAttendance.status);
  const total = rows.reduce((s, r) => s + r.c, 0);
  const attended = rows.filter((r) => (ATTENDED as readonly string[]).includes(r.status)).reduce((s, r) => s + r.c, 0);
  await tx.update(sessions).set({ attendedCount: attended, totalCount: total, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
  return { attended, total };
}

/**
 * Each student's attendance %, from every session she was marked in that was
 * not cancelled (pending sessions count, as the design says reports do).
 */
export async function refreshLearnerAttendance(tx: DbOrTx, learnerIds: string[]): Promise<void> {
  if (learnerIds.length === 0) return;
  // One value per learner asked for, NULL when no counted session marked her.
  await tx.execute(sql`
    UPDATE learners AS l
       SET attendance_pct = (
             SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present', 'late')) / NULLIF(count(*), 0))::smallint
               FROM session_attendance sa
               JOIN sessions s ON s.id = sa.session_id
              WHERE sa.learner_id = l.id
                AND s.status <> 'cancelled'
           ),
           updated_at = now()
     WHERE l.id IN (${sql.join(learnerIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
}

/** One of the four marks as a person or a file wrote it, or null. */
export function attendanceStatus(raw: string): AttendanceStatus | null {
  return (ATTENDANCE_STATUSES as readonly string[]).includes(raw) ? (raw as AttendanceStatus) : null;
}

/**
 * Write students' marks on her session: upsert them, then bring the session's
 * counts and each marked student's attendance % up to date, in one transaction
 * that first confirms the session may still change. The roster form and the
 * CSV upload both end here, so they cannot disagree about what a mark is.
 * null when the session was sent for approval in the meantime.
 */
export async function saveSessionMarks(
  db: Db,
  sessionId: string,
  userId: string,
  marks: ReadonlyArray<{ learnerId: string; status: AttendanceStatus }>,
): Promise<{ attended: number; total: number } | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    if (!(await lockEditableSession(tx, sessionId))) return null;
    for (const m of marks) {
      await tx
        .insert(sessionAttendance)
        .values({ sessionId, learnerId: m.learnerId, status: m.status, markedByUserId: userId, markedAt: now })
        .onConflictDoUpdate({
          target: [sessionAttendance.sessionId, sessionAttendance.learnerId],
          set: { status: m.status, markedByUserId: userId, markedAt: now },
        });
    }
    const counts = await recomputeSessionCounts(tx, sessionId);
    await refreshLearnerAttendance(
      tx,
      marks.map((m) => m.learnerId),
    );
    return counts;
  });
}

/**
 * Why a session cannot be sent for approval yet (an errors.* key), or null. A
 * session is sent once it has happened: complete -- with every student of the
 * class marked, when it has students -- or cancelled. The page shows the
 * reason in place of the form; the action refuses with it.
 */
export async function sessionSubmitBlocker(
  db: Db,
  s: { id: string; classId: string; section: string | null; status: string },
): Promise<"sessionNotDone" | "attendanceFirst" | null> {
  if (s.status !== "complete" && s.status !== "cancelled") return "sessionNotDone";
  if (s.status === "complete") {
    const students = await roster(db, s.classId, s.section);
    // A CSV can mark some of the class and leave the rest unmarked; sent like
    // that, the approver would see a total smaller than the class.
    if (students.length > 0) {
      const marked = await attendanceOf(db, s.id);
      if (students.some((st) => !marked.has(st.id))) return "attendanceFirst";
    }
  }
  return null;
}

/** A session's attendance, learner by learner. */
export async function attendanceOf(db: Db, sessionId: string): Promise<Map<string, AttendanceStatus>> {
  const rows = await db
    .select({ learnerId: sessionAttendance.learnerId, status: sessionAttendance.status })
    .from(sessionAttendance)
    .where(eq(sessionAttendance.sessionId, sessionId));
  return new Map(rows.map((r) => [r.learnerId, r.status as AttendanceStatus]));
}

// ── approvals, as the owner sees them ────────────────────────────────────────

export type HistoryEntry = {
  status: string;
  note: string | null;
  comment: string | null;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
};

/** Every request for one item, newest first: what she sent and what came back. */
export async function approvalHistory(db: Db, itemType: ApprovalItemType, itemId: string): Promise<HistoryEntry[]> {
  const decider = sql<string | null>`(select coalesce(u.name, u.email) from users u where u.id = ${approvals.decidedByUserId})`;
  return db
    .select({
      status: approvals.status,
      note: approvals.note,
      comment: approvals.comment,
      submittedAt: approvals.submittedAt,
      decidedAt: approvals.decidedAt,
      decidedBy: decider,
    })
    .from(approvals)
    .where(and(eq(approvals.itemType, itemType), eq(approvals.itemId, itemId)))
    .orderBy(desc(approvals.submittedAt));
}

export type Returned = {
  kind: "session" | "lesson_plan" | "assessment";
  id: string;
  title: string;
  state: "changes_requested" | "rejected";
  href: string;
};

/** Her records an approver sent back (changes requested or rejected), newest first. */
export async function returnedRecords(db: Db, teacherId: string): Promise<Returned[]> {
  const back = ["changes_requested", "rejected"];
  const [s, p, a] = await Promise.all([
    db
      .select({ id: sessions.id, topic: sessions.topic, date: sessions.scheduledDate, state: sessions.approvalStatus, at: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.teacherId, teacherId), inArray(sessions.approvalStatus, back))),
    db
      .select({ id: courseOutlines.id, name: courseOutlines.name, state: courseOutlines.approvalStatus, at: courseOutlines.updatedAt })
      .from(courseOutlines)
      .where(and(eq(courseOutlines.ownerTeacherId, teacherId), inArray(courseOutlines.approvalStatus, back))),
    db
      .select({ id: assessments.id, title: assessments.title, state: assessments.approvalStatus, at: assessments.updatedAt })
      .from(assessments)
      .where(and(eq(assessments.teacherId, teacherId), inArray(assessments.approvalStatus, back))),
  ]);
  const out: Array<Returned & { at: Date }> = [
    ...s.map((r) => ({
      kind: "session" as const,
      id: r.id,
      title: [r.topic, r.date].filter(Boolean).join(" · "),
      state: r.state as Returned["state"],
      href: `/teaching/sessions/${r.id}`,
      at: r.at,
    })),
    ...p.map((r) => ({ kind: "lesson_plan" as const, id: r.id, title: r.name, state: r.state as Returned["state"], href: `/teaching/plans/${r.id}`, at: r.at })),
    ...a.map((r) => ({ kind: "assessment" as const, id: r.id, title: r.title, state: r.state as Returned["state"], href: `/teaching/marks/${r.id}`, at: r.at })),
  ];
  return out.sort((x, y) => y.at.getTime() - x.at.getTime()).map(({ at: _at, ...r }) => r);
}

/** Her counts, for the hub and the dashboard card. */
export async function hubCounts(db: Db, teacherId: string) {
  const [links, students, [plans], [sessionRows], [marks], [pending]] = await Promise.all([
    myClassLinks(db, teacherId),
    myStudentCount(db, teacherId),
    db.select({ c: count() }).from(courseOutlines).where(eq(courseOutlines.ownerTeacherId, teacherId)),
    db.select({ c: count() }).from(sessions).where(eq(sessions.teacherId, teacherId)),
    db.select({ c: count() }).from(assessments).where(eq(assessments.teacherId, teacherId)),
    db
      .select({ c: count() })
      .from(approvals)
      .where(
        and(
          eq(approvals.status, "pending"),
          or(
            and(eq(approvals.itemType, "session"), sql`${approvals.itemId} IN (SELECT id FROM sessions WHERE teacher_id = ${teacherId})`),
            and(
              eq(approvals.itemType, "lesson_plan"),
              sql`${approvals.itemId} IN (SELECT id FROM course_outlines WHERE owner_teacher_id = ${teacherId})`,
            ),
            and(eq(approvals.itemType, "assessment"), sql`${approvals.itemId} IN (SELECT id FROM assessments WHERE teacher_id = ${teacherId})`),
          ),
        ),
      ),
  ]);
  return {
    classes: links.length,
    students,
    plans: plans?.c ?? 0,
    sessions: sessionRows?.c ?? 0,
    marks: marks?.c ?? 0,
    pending: pending?.c ?? 0,
  };
}
