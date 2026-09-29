import "server-only";

// A teacher's assessments and her students' marks: what /teaching/marks does.
//
//   createAssessment   a test for one of HER classes (and section), a subject,
//                      a maximum; optionally the student scale to grade with
//   updateAssessment   its title, subject, maximum, date, term and scale
//   saveMarks          each student's marks, absent, remark -- only students
//                      on that class's roster
//   assessmentAccess   who may open one: the teacher who set it (to edit
//                      while it is a draft or sent back) or a programme admin
//                      (to read, as the approver); nobody else
//
// Ownership comes from lib/teaching (her teachers row, her classes, her
// roster); whether she may still change it from lib/approvals (isEditable:
// pending and approved records are locked). Both are checked here, on the
// server, whatever the page offered. Every write is audited. Grades are
// computed, never stored: ./summary.ts over ./scales.ts resolveScale.

import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  assessmentMarks,
  assessments,
  classes,
  gradingScales,
  learners,
  schools,
  subjects,
  teachers,
} from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { isEditable } from "@/lib/approvals";
import { myTeacher, ownsAssessment, roster, teachesClass } from "@/lib/teaching";
import type { Actor, Db } from "@/lib/visibility";
import { isUuid } from "@/lib/ids";
import { parseSection } from "@/lib/teaching/records";
import { parseMarks } from "./summary";

export const MARKS_READERS = ["programme_admin", "super_admin"] as const;

export type MarksError =
  | "not_teacher"
  | "not_found"
  | "locked"
  | "class_not_yours"
  | "subject"
  | "title"
  | "max_marks"
  | "date"
  | "term"
  | "scale"
  | "max_below_marks"
  | "marks_value"
  | "remark"
  | "not_on_roster";

export type MarksResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: MarksError; detail?: Record<string, string | number> };

const fail = (error: MarksError, detail?: Record<string, string | number>) => ({ ok: false as const, error, detail });

export type AssessmentFields = {
  title: string;
  subjectId: string;
  maxMarks: number;
  assessedOn: string | null;
  term: number | null;
  gradingScaleId: string | null;
};

/** "classId" or "classId:A": one of her classes, as the create form names it. */
export function parseClassKey(key: string): { classId: string; section: string | null } | null {
  const [classId, section = ""] = key.split(":");
  if (!isUuid(classId)) return null;
  // Read as the teaching pages store a section (upper-cased), or a hand-made
  // "id:a" names a section no student is in.
  const s = parseSection(section);
  return s === undefined ? null : { classId, section: s };
}

/**
 * Check an assessment's details. `current` is what it has now: a subject or
 * scale switched off since it was chosen may be kept, not newly picked.
 */
async function checkFields(
  db: Db,
  f: AssessmentFields,
  current: { subjectId: string; gradingScaleId: string | null } | null = null,
): Promise<MarksError | null> {
  const title = f.title.trim();
  if (!title || title.length > 200) return "title";
  if (!Number.isInteger(f.maxMarks) || f.maxMarks < 1 || f.maxMarks > 1000) return "max_marks";
  if (f.assessedOn != null && (!/^\d{4}-\d{2}-\d{2}$/.test(f.assessedOn) || Number.isNaN(Date.parse(f.assessedOn)))) return "date";
  if (f.term != null && (!Number.isInteger(f.term) || f.term < 1 || f.term > 6)) return "term";
  if (!isUuid(f.subjectId)) return "subject";
  const [subject] = await db.select({ active: subjects.active }).from(subjects).where(eq(subjects.id, f.subjectId)).limit(1);
  if (!subject || (!subject.active && f.subjectId !== current?.subjectId)) return "subject";
  if (f.gradingScaleId) {
    if (!isUuid(f.gradingScaleId)) return "scale";
    const [s] = await db
      .select({ appliesTo: gradingScales.appliesTo, active: gradingScales.active })
      .from(gradingScales)
      .where(eq(gradingScales.id, f.gradingScaleId))
      .limit(1);
    if (!s || s.appliesTo !== "student") return "scale";
    if (!s.active && f.gradingScaleId !== current?.gradingScaleId) return "scale";
  }
  return null;
}

/** A new assessment for one of her classes. It starts as a draft. */
export async function createAssessment(
  db: Db,
  actor: Actor,
  input: AssessmentFields & { classKey: string },
): Promise<MarksResult> {
  const me = await myTeacher(db, actor);
  if (!me) return fail("not_teacher");
  const klass = parseClassKey(input.classKey);
  if (!klass || !(await teachesClass(db, me.id, klass.classId, klass.section))) return fail("class_not_yours");
  const bad = await checkFields(db, input);
  if (bad) return fail(bad);
  const [row] = await db
    .insert(assessments)
    .values({
      teacherId: me.id,
      classId: klass.classId,
      section: klass.section,
      subjectId: input.subjectId,
      title: input.title.trim(),
      maxMarks: input.maxMarks,
      assessedOn: input.assessedOn,
      term: input.term,
      gradingScaleId: input.gradingScaleId || null,
      approvalStatus: "draft",
    })
    .returning({ id: assessments.id });
  await recordAudit({
    action: "teaching.marks.assessment_saved",
    entityType: "assessment",
    entityId: row!.id,
    userId: actor.id,
    metadata: { created: true, classId: klass.classId, subjectId: input.subjectId, maxMarks: input.maxMarks },
  });
  return { ok: true, id: row!.id };
}

/** Her own assessment, still editable, or why not. */
async function mineAndEditable(db: Db, actor: Actor, id: string): Promise<MarksResult<{ teacherId: string }>> {
  if (!isUuid(id)) return fail("not_found");
  const me = await myTeacher(db, actor);
  if (!me) return fail("not_teacher");
  if (!(await ownsAssessment(db, me.id, id))) return fail("not_found");
  const [row] = await db.select({ state: assessments.approvalStatus }).from(assessments).where(eq(assessments.id, id)).limit(1);
  if (!row) return fail("not_found");
  if (!isEditable(row.state)) return fail("locked");
  return { ok: true, teacherId: me.id };
}

/** Change an assessment's details. The class is fixed: its marks are that class's. */
export async function updateAssessment(db: Db, actor: Actor, id: string, input: AssessmentFields): Promise<MarksResult> {
  const mine = await mineAndEditable(db, actor, id);
  if (!mine.ok) return mine;
  const [current] = await db
    .select({ subjectId: assessments.subjectId, gradingScaleId: assessments.gradingScaleId })
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  const bad = await checkFields(db, input, current ?? null);
  if (bad) return fail(bad);
  const [top] = await db
    .select({ n: max(assessmentMarks.marks) })
    .from(assessmentMarks)
    .where(eq(assessmentMarks.assessmentId, id));
  const highest = top?.n == null ? null : Number(top.n);
  if (highest != null && highest > input.maxMarks) return fail("max_below_marks", { highest });
  const [row] = await db
    .update(assessments)
    .set({
      title: input.title.trim(),
      subjectId: input.subjectId,
      maxMarks: input.maxMarks,
      assessedOn: input.assessedOn,
      term: input.term,
      gradingScaleId: input.gradingScaleId || null,
      updatedAt: new Date(),
    })
    // Still editable at the moment of writing: a submission in between wins.
    .where(and(eq(assessments.id, id), inArray(assessments.approvalStatus, ["draft", "changes_requested", "rejected"])))
    .returning({ id: assessments.id, classId: assessments.classId });
  if (!row) return fail("locked");
  await recordAudit({
    action: "teaching.marks.assessment_saved",
    entityType: "assessment",
    entityId: id,
    userId: actor.id,
    metadata: { created: false, classId: row.classId, subjectId: input.subjectId, maxMarks: input.maxMarks },
  });
  return { ok: true, id };
}

export type MarkInput = { learnerId: string; marks: string; absent: boolean; remark: string };

/**
 * Save the marks of her students. A student left blank (no marks, not absent,
 * no remark) has no row; one marked absent has no marks. Only students on the
 * class's roster are accepted.
 */
export async function saveMarks(
  db: Db,
  actor: Actor,
  id: string,
  entries: readonly MarkInput[],
): Promise<MarksResult<{ id: string; marked: number; absent: number; cleared: number }>> {
  const mine = await mineAndEditable(db, actor, id);
  if (!mine.ok) return mine;
  const [a] = await db
    .select({ classId: assessments.classId, section: assessments.section, maxMarks: assessments.maxMarks })
    .from(assessments)
    .where(eq(assessments.id, id))
    .limit(1);
  if (!a) return fail("not_found");
  const students = await roster(db, a.classId, a.section);
  const onRoster = new Map(students.map((s) => [s.id, s.name]));

  type Parsed = { learnerId: string; marks: number | null; absent: boolean; remark: string | null };
  const parsed: Parsed[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!onRoster.has(e.learnerId)) return fail("not_on_roster");
    if (seen.has(e.learnerId)) continue;
    seen.add(e.learnerId);
    const name = onRoster.get(e.learnerId)!;
    const remark = e.remark.trim();
    if (remark.length > 240) return fail("remark", { name });
    const marks = e.absent ? null : parseMarks(e.marks, a.maxMarks);
    if (marks === undefined) return fail("marks_value", { name, max: a.maxMarks });
    parsed.push({ learnerId: e.learnerId, marks, absent: e.absent, remark: remark || null });
  }

  const counts = await db.transaction(async (tx) => {
    // Hold the assessment while writing, and look at its state again: a
    // submission for approval waits for this to finish, or wins before it.
    const [locked] = await tx
      .select({ state: assessments.approvalStatus })
      .from(assessments)
      .where(eq(assessments.id, id))
      .for("update");
    if (!locked || !isEditable(locked.state)) return null;
    let marked = 0;
    let absent = 0;
    const clear: string[] = [];
    for (const p of parsed) {
      if (p.marks == null && !p.absent && !p.remark) {
        clear.push(p.learnerId);
        continue;
      }
      if (p.absent) absent++;
      else if (p.marks != null) marked++;
      await tx
        .insert(assessmentMarks)
        .values({
          assessmentId: id,
          learnerId: p.learnerId,
          marks: p.marks == null ? null : String(p.marks),
          absent: p.absent,
          remark: p.remark,
        })
        .onConflictDoUpdate({
          target: [assessmentMarks.assessmentId, assessmentMarks.learnerId],
          set: {
            marks: p.marks == null ? null : String(p.marks),
            absent: p.absent,
            remark: p.remark,
            updatedAt: new Date(),
          },
        });
    }
    let cleared = 0;
    if (clear.length) {
      const gone = await tx
        .delete(assessmentMarks)
        .where(and(eq(assessmentMarks.assessmentId, id), inArray(assessmentMarks.learnerId, clear)))
        .returning({ id: assessmentMarks.id });
      cleared = gone.length;
    }
    await tx.update(assessments).set({ updatedAt: new Date() }).where(eq(assessments.id, id));
    return { marked, absent, cleared };
  });
  if (!counts) return fail("locked");
  await recordAudit({
    action: "teaching.marks.saved",
    entityType: "assessment",
    entityId: id,
    userId: actor.id,
    metadata: counts,
  });
  return { ok: true, id, ...counts };
}

/** Does this assessment have any marks or absences recorded? (Nothing to approve otherwise.) */
export async function hasMarks(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assessmentMarks)
    .where(eq(assessmentMarks.assessmentId, id));
  return (row?.n ?? 0) > 0;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export type AssessmentAccess = { mode: "owner"; teacherId: string } | { mode: "reader" };

/**
 * Who may open this assessment: the teacher who set it, or a programme
 * admin / super admin reading it as the approver. Anyone else: null (the page
 * answers 404, so another teacher cannot even learn that it exists).
 */
export async function assessmentAccess(db: Db, actor: Actor, id: string): Promise<AssessmentAccess | null> {
  if (!isUuid(id)) return null;
  if (hasAnyRole(actor.role, MARKS_READERS)) {
    const [row] = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.id, id)).limit(1);
    return row ? { mode: "reader" } : null;
  }
  const me = await myTeacher(db, actor);
  if (!me) return null;
  return (await ownsAssessment(db, me.id, id)) ? { mode: "owner", teacherId: me.id } : null;
}

export async function assessmentHeader(db: Db, id: string) {
  const [row] = await db
    .select({
      id: assessments.id,
      title: assessments.title,
      classId: assessments.classId,
      section: assessments.section,
      grade: classes.grade,
      school: schools.name,
      subjectId: assessments.subjectId,
      subject: subjects.name,
      teacher: teachers.fullName,
      maxMarks: assessments.maxMarks,
      assessedOn: assessments.assessedOn,
      term: assessments.term,
      gradingScaleId: assessments.gradingScaleId,
      approvalStatus: assessments.approvalStatus,
      updatedAt: assessments.updatedAt,
    })
    .from(assessments)
    .innerJoin(classes, eq(classes.id, assessments.classId))
    .innerJoin(schools, eq(schools.id, classes.schoolId))
    .innerJoin(subjects, eq(subjects.id, assessments.subjectId))
    .innerJoin(teachers, eq(teachers.id, assessments.teacherId))
    .where(eq(assessments.id, id))
    .limit(1);
  return row ?? null;
}

export type MarkSheetRow = {
  learnerId: string;
  name: string;
  rollNumber: string | null;
  marks: number | null;
  absent: boolean;
  remark: string | null;
  /** False for a student with marks who is no longer on the roster (left, moved): shown, not editable. */
  onRoster: boolean;
};

/** The roster with each student's recorded marks, and any marked student no longer on it. */
export async function markSheet(db: Db, a: { id: string; classId: string; section: string | null }): Promise<MarkSheetRow[]> {
  const [students, recorded] = await Promise.all([
    roster(db, a.classId, a.section),
    db
      .select({
        learnerId: assessmentMarks.learnerId,
        name: learners.name,
        rollNumber: learners.rollNumber,
        marks: assessmentMarks.marks,
        absent: assessmentMarks.absent,
        remark: assessmentMarks.remark,
      })
      .from(assessmentMarks)
      .innerJoin(learners, eq(learners.id, assessmentMarks.learnerId))
      .where(eq(assessmentMarks.assessmentId, a.id))
      .orderBy(asc(learners.rollNumber), asc(learners.name)),
  ]);
  const byLearner = new Map(recorded.map((r) => [r.learnerId, r]));
  const rows: MarkSheetRow[] = students.map((s) => {
    const r = byLearner.get(s.id);
    return {
      learnerId: s.id,
      name: s.name,
      rollNumber: s.rollNumber,
      marks: r?.marks == null ? null : Number(r.marks),
      absent: r?.absent ?? false,
      remark: r?.remark ?? null,
      onRoster: true,
    };
  });
  const listed = new Set(students.map((s) => s.id));
  for (const r of recorded) {
    if (listed.has(r.learnerId)) continue;
    rows.push({
      learnerId: r.learnerId,
      name: r.name,
      rollNumber: r.rollNumber,
      marks: r.marks == null ? null : Number(r.marks),
      absent: r.absent,
      remark: r.remark,
      onRoster: false,
    });
  }
  return rows;
}

export type AssessmentListRow = {
  id: string;
  title: string;
  grade: number;
  section: string | null;
  subject: string;
  teacher: string;
  assessedOn: string | null;
  maxMarks: number;
  approvalStatus: string;
  entered: number;
};

function listQuery(db: Db) {
  return db
    .select({
      id: assessments.id,
      title: assessments.title,
      grade: classes.grade,
      section: assessments.section,
      subject: subjects.name,
      teacher: teachers.fullName,
      assessedOn: assessments.assessedOn,
      maxMarks: assessments.maxMarks,
      approvalStatus: assessments.approvalStatus,
      entered: sql<number>`(select count(*)::int from assessment_marks m where m.assessment_id = ${assessments.id})`,
    })
    .from(assessments)
    .innerJoin(classes, eq(classes.id, assessments.classId))
    .innerJoin(subjects, eq(subjects.id, assessments.subjectId))
    .innerJoin(teachers, eq(teachers.id, assessments.teacherId));
}

/** Her assessments, newest first. */
export async function myAssessments(db: Db, teacherId: string): Promise<AssessmentListRow[]> {
  return listQuery(db)
    .where(eq(assessments.teacherId, teacherId))
    .orderBy(sql`${assessments.assessedOn} desc nulls last`, desc(assessments.createdAt))
    .limit(300);
}

/** Every teacher's assessments, for a programme admin, newest first. */
export async function allAssessments(db: Db, limit = 200): Promise<AssessmentListRow[]> {
  return listQuery(db)
    .orderBy(sql`${assessments.assessedOn} desc nulls last`, desc(assessments.createdAt))
    .limit(limit);
}
