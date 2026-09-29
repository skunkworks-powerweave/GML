// The database-backed row rules of the teaching-records data tables
// (AdminEntity.validate): what zod cannot check because it needs another
// row. Each returns field -> message key (adminData.validation.*), or null,
// and judges only what the write sets or changes, so a value stored long ago
// does not block an unrelated edit. Run by the grid's create and update and
// by the CSV import (admin/access.ts entityRowProblems). No server-only
// marker: the entity definitions that use them are also read by the client
// form, which never calls them.

import { eq } from "drizzle-orm";
import {
  assessments,
  classes,
  gradingScales,
  learners,
  quizQuestions,
  sessions,
  teachers,
  type GradingTarget,
} from "@gml/db/schema";
import type { AdminDb, AdminMessage } from "./types";

/**
 * A rule for a field that names a grade scale: the scale must be one for
 * `kind`. A quiz graded on the observation scale, or a rubric on the student
 * scale, would show bands meant for something else. Judged when the field is
 * set or changed, so a scale re-purposed since does not block unrelated edits.
 */
export function scaleOfKind(field: string, kind: GradingTarget) {
  return async (
    db: AdminDb,
    row: Record<string, unknown>,
    before?: Record<string, unknown>,
  ): Promise<Record<string, AdminMessage> | null> => {
    const id = row[field];
    if (typeof id !== "string" || !id) return null;
    if (before && before[field] === id) return null;
    const [scale] = await db
      .select({ appliesTo: gradingScales.appliesTo })
      .from(gradingScales)
      .where(eq(gradingScales.id, id))
      .limit(1);
    // A missing scale is the foreign key's to report.
    if (!scale || scale.appliesTo === kind) return null;
    return { [field]: { key: `validation.scaleFor.${kind}` } };
  };
}

/** Run several database-backed rules; the first field to fail each keeps its message. */
export function allRules(
  ...rules: Array<
    (db: AdminDb, row: Record<string, unknown>, before?: Record<string, unknown>) => Promise<Record<string, AdminMessage> | null>
  >
) {
  return async (db: AdminDb, row: Record<string, unknown>, before?: Record<string, unknown>) => {
    const out: Record<string, AdminMessage> = {};
    for (const rule of rules) {
      const problems = await rule(db, row, before);
      if (problems) for (const [f, m] of Object.entries(problems)) out[f] ??= m;
    }
    return Object.keys(out).length ? out : null;
  };
}

type Rule = (
  db: AdminDb,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
) => Promise<Record<string, AdminMessage> | null>;

/** Did this write set or change any of `fields`? (Always, on a create.) */
function touches(fields: string[], row: Record<string, unknown>, before?: Record<string, unknown>): boolean {
  return !before || fields.some((f) => f in row && row[f] !== before[f]);
}

/**
 * The class must be at the teacher's own school. A teacher keeps "her
 * classes at her school" (the design); a link to another school's class would
 * put that school's roster on her "My students". Judged when either changes.
 */
export function classAtTeachersSchool(teacherField = "teacherId", classField = "classId"): Rule {
  return async (db, row, before) => {
    const teacherId = row[teacherField];
    const classId = row[classField];
    if (typeof teacherId !== "string" || typeof classId !== "string") return null;
    if (!touches([teacherField, classField], row, before)) return null;
    const [t] = await db.select({ schoolId: teachers.schoolId }).from(teachers).where(eq(teachers.id, teacherId)).limit(1);
    const [c] = await db.select({ schoolId: classes.schoolId }).from(classes).where(eq(classes.id, classId)).limit(1);
    // A missing row is the foreign key's to report.
    if (!t || !c || t.schoolId === c.schoolId) return null;
    return { [classField]: { key: "validation.classAtTeachersSchool" } };
  };
}

/**
 * The student must belong to the class of the record she is marked on -- the
 * session's (and its section, when the session names one) or the
 * assessment's. Otherwise a class's attendance or marks would list a child
 * from another school. Judged when the learner or the record changes.
 */
export function learnerOfRecordClass(recordField: "sessionId" | "assessmentId"): Rule {
  return async (db, row, before) => {
    const recordId = row[recordField];
    const learnerId = row.learnerId;
    if (typeof recordId !== "string" || typeof learnerId !== "string") return null;
    if (!touches([recordField, "learnerId"], row, before)) return null;
    const table = recordField === "sessionId" ? sessions : assessments;
    const [record] = await db
      .select({ classId: table.classId, section: table.section })
      .from(table)
      .where(eq(table.id, recordId))
      .limit(1);
    const [learner] = await db
      .select({ classId: learners.classId, section: learners.section })
      .from(learners)
      .where(eq(learners.id, learnerId))
      .limit(1);
    if (!record || !learner) return null;
    const sameClass = record.classId === learner.classId;
    // A section on the record limits it to that section; a learner with no
    // section recorded is taken to be in every section, as lib/teaching's
    // roster does.
    const sameSection = !record.section || !learner.section || record.section === learner.section;
    return sameClass && sameSection ? null : { learnerId: { key: "validation.learnerNotInClass" } };
  };
}

/** A test's marks cannot be more than its maximum, nor recorded for an absent student. */
export const marksWithinMaximum: Rule = async (db, row, before) => {
  const assessmentId = row.assessmentId;
  const marks = row.marks;
  if (typeof assessmentId !== "string" || marks === null || marks === undefined || marks === "") return null;
  if (!touches(["assessmentId", "marks"], row, before)) return null;
  const [a] = await db
    .select({ maxMarks: assessments.maxMarks })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .limit(1);
  if (!a || Number(marks) <= a.maxMarks) return null;
  return { marks: { key: "validation.marksOverMaximum", values: { max: a.maxMarks } } };
};

/**
 * A quiz goes live only with questions: /quizzes/[slug] serves active quizzes,
 * so an active quiz with none is an empty page for every learner. (The quiz
 * editor at /admin/quizzes/[id] adds the questions.)
 */
export const quizActiveHasQuestions: Rule = async (db, row, before) => {
  if (row.active !== true || before?.active === true) return null;
  if (typeof before?.id !== "string") return { active: { key: "validation.quizNoQuestions" } };
  const [q] = await db
    .select({ id: quizQuestions.id })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, before.id))
    .limit(1);
  return q ? null : { active: { key: "validation.quizNoQuestions" } };
};
