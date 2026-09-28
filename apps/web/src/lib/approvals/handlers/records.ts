// Approval handlers for the records a teacher enters herself: a session (with
// its attendance), a lesson plan (her course outline) and an assessment (with
// its marks). A programme admin decides all three.
//
// Each record carries its own approval_status (draft / pending / approved /
// changes_requested / rejected). Submitting moves an editable record to
// pending; the decision writes its outcome. The teacher may edit a record
// only while it is draft, changes_requested or rejected (isEditable below):
// pending waits for the approver, and approved is locked.

import { eq, inArray } from "drizzle-orm";
import {
  assessments,
  classes,
  courseOutlines,
  sessions,
  subjects,
  teachers,
  type RecordApprovalState,
} from "@gml/db/schema";
import { teacherIdFor } from "@/lib/visibility";
import type { ApprovalHandler, DbOrTx, ItemSummary } from "../types";

const EDITABLE: readonly RecordApprovalState[] = ["draft", "changes_requested", "rejected"];

/** May the teacher still change a record in this state? */
export function isEditable(state: string): boolean {
  return (EDITABLE as readonly string[]).includes(state);
}

const PROGRAMME_ADMINS = ["programme_admin", "super_admin"] as const;

/** "Grade 5 A" -- the class as a teacher says it. */
function classLabel(grade: number | null, section: string | null): string {
  if (grade == null) return "";
  return section ? `${grade} ${section}` : String(grade);
}

export const sessionHandler: ApprovalHandler = {
  type: "session",
  deciderRoles: PROGRAMME_ADMINS,
  async canSubmit(db, actor, itemId) {
    const teacherId = await teacherIdFor(db as never, actor);
    if (!teacherId) return false;
    const [row] = await db
      .select({ teacherId: sessions.teacherId, state: sessions.approvalStatus })
      .from(sessions)
      .where(eq(sessions.id, itemId))
      .limit(1);
    return !!row && row.teacherId === teacherId && isEditable(row.state);
  },
  async onSubmit(tx, itemId) {
    await tx.update(sessions).set({ approvalStatus: "pending", updatedAt: new Date() }).where(eq(sessions.id, itemId));
  },
  async onDecision(tx, itemId, decision) {
    await tx.update(sessions).set({ approvalStatus: decision, updatedAt: new Date() }).where(eq(sessions.id, itemId));
  },
  async describe(db: DbOrTx, itemIds: string[]) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: sessions.id,
        topic: sessions.topic,
        date: sessions.scheduledDate,
        section: sessions.section,
        grade: classes.grade,
        subject: subjects.name,
        teacher: teachers.fullName,
      })
      .from(sessions)
      .leftJoin(classes, eq(classes.id, sessions.classId))
      .leftJoin(subjects, eq(subjects.id, sessions.subjectId))
      .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
      .where(inArray(sessions.id, itemIds));
    for (const r of rows) {
      out.set(r.id, {
        title: [r.topic, r.date].filter(Boolean).join(" · "),
        subtitle: [r.teacher, r.subject, classLabel(r.grade, r.section)].filter(Boolean).join(" · "),
        href: `/teaching/sessions/${r.id}`,
      });
    }
    return out;
  },
};

export const lessonPlanHandler: ApprovalHandler = {
  type: "lesson_plan",
  deciderRoles: PROGRAMME_ADMINS,
  async canSubmit(db, actor, itemId) {
    const teacherId = await teacherIdFor(db as never, actor);
    if (!teacherId) return false;
    const [row] = await db
      .select({ owner: courseOutlines.ownerTeacherId, state: courseOutlines.approvalStatus })
      .from(courseOutlines)
      .where(eq(courseOutlines.id, itemId))
      .limit(1);
    return !!row && row.owner === teacherId && isEditable(row.state);
  },
  async onSubmit(tx, itemId) {
    await tx.update(courseOutlines).set({ approvalStatus: "pending", updatedAt: new Date() }).where(eq(courseOutlines.id, itemId));
  },
  async onDecision(tx, itemId, decision) {
    await tx.update(courseOutlines).set({ approvalStatus: decision, updatedAt: new Date() }).where(eq(courseOutlines.id, itemId));
  },
  async describe(db, itemIds) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: courseOutlines.id,
        name: courseOutlines.name,
        grade: courseOutlines.grade,
        term: courseOutlines.term,
        subject: subjects.name,
        teacher: teachers.fullName,
      })
      .from(courseOutlines)
      .leftJoin(subjects, eq(subjects.id, courseOutlines.subjectId))
      .leftJoin(teachers, eq(teachers.id, courseOutlines.ownerTeacherId))
      .where(inArray(courseOutlines.id, itemIds));
    for (const r of rows) {
      out.set(r.id, {
        title: r.name,
        subtitle: [r.teacher, r.subject, `${r.grade} · T${r.term}`].filter(Boolean).join(" · "),
        href: `/teaching/plans/${r.id}`,
      });
    }
    return out;
  },
};

export const assessmentHandler: ApprovalHandler = {
  type: "assessment",
  deciderRoles: PROGRAMME_ADMINS,
  async canSubmit(db, actor, itemId) {
    const teacherId = await teacherIdFor(db as never, actor);
    if (!teacherId) return false;
    const [row] = await db
      .select({ teacherId: assessments.teacherId, state: assessments.approvalStatus })
      .from(assessments)
      .where(eq(assessments.id, itemId))
      .limit(1);
    return !!row && row.teacherId === teacherId && isEditable(row.state);
  },
  async onSubmit(tx, itemId) {
    await tx.update(assessments).set({ approvalStatus: "pending", updatedAt: new Date() }).where(eq(assessments.id, itemId));
  },
  async onDecision(tx, itemId, decision) {
    await tx.update(assessments).set({ approvalStatus: decision, updatedAt: new Date() }).where(eq(assessments.id, itemId));
  },
  async describe(db, itemIds) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: assessments.id,
        title: assessments.title,
        date: assessments.assessedOn,
        section: assessments.section,
        grade: classes.grade,
        subject: subjects.name,
        teacher: teachers.fullName,
      })
      .from(assessments)
      .leftJoin(classes, eq(classes.id, assessments.classId))
      .leftJoin(subjects, eq(subjects.id, assessments.subjectId))
      .leftJoin(teachers, eq(teachers.id, assessments.teacherId))
      .where(inArray(assessments.id, itemIds));
    for (const r of rows) {
      out.set(r.id, {
        title: [r.title, r.date].filter(Boolean).join(" · "),
        subtitle: [r.teacher, r.subject, classLabel(r.grade, r.section)].filter(Boolean).join(" · "),
        href: `/teaching/marks/${r.id}`,
      });
    }
    return out;
  },
};

