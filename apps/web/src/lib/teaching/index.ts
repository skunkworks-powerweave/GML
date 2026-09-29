import "server-only";

// "Her own": which classes, students, sessions, plans and marks belong to the
// signed-in teacher. Every teaching page and action decides ownership through
// here, so "a teacher sees and changes only her own records" has one
// definition.
//
//   her classes    the classes she is linked to in teacher_classes (a class is
//                  a school's grade; the link may name a section)
//   her students   active, not deleted learners of those classes, limited to
//                  the link's section when it names one
//   her records    sessions and assessments with her teacher_id, course
//                  outlines she owns (owner_teacher_id)
//
// A teacher account with no teachers row owns nothing. Design:
// docs/superpowers/specs/2026-09-28-teaching-records-design.md.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { assessments, classes, courseOutlines, learners, sessions, teacherClasses, teachers } from "@gml/db/schema";
import type { Actor, Db } from "@/lib/visibility";

export type MyTeacher = { id: string; schoolId: string; name: string };

/** The signed-in teacher's own teachers row, or null (not a teacher, or not linked, or inactive). */
export async function myTeacher(db: Db, actor: Actor): Promise<MyTeacher | null> {
  if (actor.role !== "teacher") return null;
  const [row] = await db
    .select({ id: teachers.id, schoolId: teachers.schoolId, name: teachers.fullName, active: teachers.active })
    .from(teachers)
    .where(eq(teachers.userId, actor.id))
    .limit(1);
  return row && row.active ? { id: row.id, schoolId: row.schoolId, name: row.name } : null;
}

export type ClassLink = {
  linkId: string;
  classId: string;
  schoolId: string;
  grade: number;
  stage: string;
  section: string | null;
  subjectId: string | null;
};

/** Her classes, lowest grade first. */
export async function myClassLinks(db: Db, teacherId: string): Promise<ClassLink[]> {
  return db
    .select({
      linkId: teacherClasses.id,
      classId: teacherClasses.classId,
      schoolId: classes.schoolId,
      grade: classes.grade,
      stage: classes.stage,
      section: teacherClasses.section,
      subjectId: teacherClasses.subjectId,
    })
    .from(teacherClasses)
    .innerJoin(classes, eq(classes.id, teacherClasses.classId))
    .where(eq(teacherClasses.teacherId, teacherId))
    .orderBy(asc(classes.grade), asc(teacherClasses.section));
}

/**
 * Does she teach this class (and section)? A link with no section covers the
 * whole grade; a link to section A covers section A only.
 */
export async function teachesClass(db: Db, teacherId: string, classId: string, section: string | null = null): Promise<boolean> {
  const links = await db
    .select({ section: teacherClasses.section })
    .from(teacherClasses)
    .where(and(eq(teacherClasses.teacherId, teacherId), eq(teacherClasses.classId, classId)));
  return links.some((l) => l.section == null || (section != null && l.section === section));
}

/** The students of a class (and section), as the roster for attendance and marks. */
export async function roster(db: Db, classId: string, section: string | null = null) {
  return db
    .select({ id: learners.id, name: learners.name, rollNumber: learners.rollNumber, section: learners.section })
    .from(learners)
    .where(
      and(
        eq(learners.classId, classId),
        eq(learners.active, true),
        isNull(learners.deletedAt),
        section ? or(eq(learners.section, section), isNull(learners.section)) : undefined,
      ),
    )
    .orderBy(asc(learners.rollNumber), asc(learners.name));
}

/** Is this her session / lesson plan / assessment? */
export async function ownsSession(db: Db, teacherId: string, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ t: sessions.teacherId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return row?.t === teacherId;
}
export async function ownsPlan(db: Db, teacherId: string, outlineId: string): Promise<boolean> {
  const [row] = await db
    .select({ t: courseOutlines.ownerTeacherId })
    .from(courseOutlines)
    .where(eq(courseOutlines.id, outlineId))
    .limit(1);
  return row?.t === teacherId;
}
export async function ownsAssessment(db: Db, teacherId: string, assessmentId: string): Promise<boolean> {
  const [row] = await db.select({ t: assessments.teacherId }).from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  return row?.t === teacherId;
}
