"use server";

// Lesson plans: a teacher's OWN course outlines (course_outlines with
// owner_teacher_id = her) and their lessons.
//
//   create / edit / delete   the plan: subject, grade, term, name, weeks and
//                            learning outcomes; one plan per subject, grade and
//                            term (course_outlines_teacher_uq)
//   lessons                  add, edit, delete and move up or down; the plan's
//                            sessions_count follows the lesson count
//   start from programme     copy a programme outline (owner NULL) and its
//                            lessons into a new plan of hers
//   submit                   send it for approval (lib/approvals, lesson_plan)
//
// Every change needs the plan to be hers AND still editable: once it is
// pending or approved it is locked (lib/approvals isEditable). A programme
// outline is never changed here. Every write is audited (teaching.*).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { and, asc, count, eq, gt, lt, desc, max } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, outlineLessons } from "@gml/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { isEditable, submitForApproval } from "@/lib/approvals";
import { ownsPlan } from "@/lib/teaching";
import { signedInTeacher } from "@/lib/teaching/current";
import { lockEditablePlan, outcomesFrom, renumberLessons, subjectExists, syncSessionsCount, text, wholeNumber } from "@/lib/teaching/records";
import type { ActionState } from "@/lib/teaching/forms";
import type { MyTeacher } from "@/lib/teaching";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

const LONG_TEXT = 4000;

/** A transaction's answer when the plan stopped being editable before its write (lockEditablePlan). */
const LOCKED = Symbol("locked");

function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type PlanFields = { subjectId: string; grade: number; term: number; name: string; weeks: number | null; learningOutcomes: string[] };

async function planFields(t: Translate, fd: FormData): Promise<PlanFields | { error: string }> {
  const subjectId = text(fd, "subjectId");
  if (!isUuid(subjectId) || !(await subjectExists(db, subjectId))) return { error: t("errors.subjectRequired") };
  const grade = wholeNumber(text(fd, "grade"), 1, 12);
  if (grade == null || Number.isNaN(grade)) return { error: t("errors.gradeInvalid") };
  const term = wholeNumber(text(fd, "term"), 1, 6);
  if (term == null || Number.isNaN(term)) return { error: t("errors.termInvalid") };
  const name = text(fd, "name");
  if (!name) return { error: t("errors.planNameRequired") };
  if (name.length > 200) return { error: t("errors.tooLong", { field: t("fields.planName"), max: 200 }) };
  const weeks = wholeNumber(text(fd, "weeks"), 1, 52);
  if (Number.isNaN(weeks)) return { error: t("errors.weeksInvalid") };
  const outcomesRaw = text(fd, "learningOutcomes");
  if (outcomesRaw.length > LONG_TEXT) return { error: t("errors.tooLong", { field: t("fields.outcomes"), max: LONG_TEXT }) };
  return { subjectId, grade, term, name, weeks, learningOutcomes: outcomesFrom(outcomesRaw) };
}

/**
 * The plan named by the form's `id`, when it is hers and she may still change
 * it; otherwise the refusal. Another teacher's plan, a programme outline and a
 * missing one all read "not found": nothing tells her whose it was.
 */
async function editablePlan(t: Translate, teacher: MyTeacher, fd: FormData, field = "id"): Promise<{ id: string } | { error: string }> {
  const id = text(fd, field);
  if (!isUuid(id) || !(await ownsPlan(db, teacher.id, id))) return { error: t("errors.notFound") };
  const [row] = await db.select({ state: courseOutlines.approvalStatus }).from(courseOutlines).where(eq(courseOutlines.id, id)).limit(1);
  if (!row || !isEditable(row.state)) return { error: t("errors.locked") };
  return { id };
}

function touched(id: string) {
  revalidatePath(`/teaching/plans/${id}`);
  revalidatePath("/teaching/plans");
}

export async function createPlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const fields = await planFields(t, fd);
  if ("error" in fields) return fields;

  let id: string;
  try {
    const [row] = await db
      .insert(courseOutlines)
      .values({ ...fields, ownerTeacherId: me.teacher.id, approvalStatus: "draft", status: "planned", sessionsCount: 0 })
      .returning({ id: courseOutlines.id });
    id = row!.id;
  } catch (err) {
    if (uniqueViolation(err)) return { error: t("errors.planExists") };
    throw err;
  }
  await recordAudit({
    action: "teaching.plan.created",
    entityType: "course_outline",
    entityId: id,
    userId: me.actor.id,
    metadata: { subjectId: fields.subjectId, grade: fields.grade, term: fields.term },
  });
  revalidatePath("/teaching/plans");
  redirect(`/teaching/plans/${id}`);
}

export async function updatePlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;
  const fields = await planFields(t, fd);
  if ("error" in fields) return fields;

  try {
    const done = await db.transaction(async (tx) => {
      if (!(await lockEditablePlan(tx, plan.id))) return false;
      await tx.update(courseOutlines).set({ ...fields, updatedAt: new Date() }).where(eq(courseOutlines.id, plan.id));
      return true;
    });
    if (!done) return { error: t("errors.locked") };
  } catch (err) {
    if (uniqueViolation(err)) return { error: t("errors.planExists") };
    throw err;
  }
  await recordAudit({
    action: "teaching.plan.updated",
    entityType: "course_outline",
    entityId: plan.id,
    userId: me.actor.id,
    metadata: { subjectId: fields.subjectId, grade: fields.grade, term: fields.term },
  });
  touched(plan.id);
  return { ok: t("done.planSaved") };
}

export async function deletePlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;

  const lessons = await db.transaction(async (tx) => {
    if (!(await lockEditablePlan(tx, plan.id))) return null;
    // Sessions that used one of its lessons keep their date and topic; their
    // lesson link is cleared by outline_lesson_id's ON DELETE SET NULL.
    const gone = await tx.delete(outlineLessons).where(eq(outlineLessons.outlineId, plan.id)).returning({ id: outlineLessons.id });
    await tx.delete(courseOutlines).where(eq(courseOutlines.id, plan.id));
    return gone.length;
  });
  if (lessons === null) return { error: t("errors.locked") };
  await recordAudit({
    action: "teaching.plan.deleted",
    entityType: "course_outline",
    entityId: plan.id,
    userId: me.actor.id,
    metadata: { lessonCount: lessons },
  });
  revalidatePath("/teaching/plans");
  redirect("/teaching/plans");
}

type LessonFields = { title: string; week: number | null; objectives: string | null; activities: string | null; materials: string | null };

function lessonFields(t: Translate, fd: FormData): LessonFields | { error: string } {
  const title = text(fd, "title");
  if (!title) return { error: t("errors.lessonTitleRequired") };
  if (title.length > 240) return { error: t("errors.tooLong", { field: t("fields.lessonTitle"), max: 240 }) };
  const week = wholeNumber(text(fd, "week"), 1, 52);
  if (Number.isNaN(week)) return { error: t("errors.weekInvalid") };
  const out: LessonFields = { title, week, objectives: null, activities: null, materials: null };
  for (const k of ["objectives", "activities", "materials"] as const) {
    const v = text(fd, k);
    if (v.length > LONG_TEXT) return { error: t("errors.tooLong", { field: t(`fields.${k}`), max: LONG_TEXT }) };
    out[k] = v || null;
  }
  return out;
}

/** Add a lesson (no lessonId) at the end of her plan, or change one of its lessons. */
export async function saveLessonAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;
  const fields = lessonFields(t, fd);
  if ("error" in fields) return fields;
  const lessonId = text(fd, "lessonId");

  if (lessonId && !isUuid(lessonId)) return { error: t("errors.notFound") };
  const created = !lessonId;
  const savedId = await db.transaction(async (tx): Promise<string | typeof LOCKED | null> => {
    if (!(await lockEditablePlan(tx, plan.id))) return LOCKED;
    if (lessonId) {
      const [row] = await tx
        .update(outlineLessons)
        .set(fields)
        .where(and(eq(outlineLessons.id, lessonId), eq(outlineLessons.outlineId, plan.id)))
        .returning({ id: outlineLessons.id });
      return row?.id ?? null;
    }
    const [last] = await tx.select({ m: max(outlineLessons.sequence) }).from(outlineLessons).where(eq(outlineLessons.outlineId, plan.id));
    const [row] = await tx
      .insert(outlineLessons)
      .values({ outlineId: plan.id, sequence: (last?.m ?? 0) + 1, ...fields })
      .returning({ id: outlineLessons.id });
    await syncSessionsCount(tx, plan.id);
    return row!.id;
  });
  if (savedId === LOCKED) return { error: t("errors.locked") };
  if (savedId === null) return { error: t("errors.notFound") };
  await recordAudit({
    action: "teaching.lesson.saved",
    entityType: "outline_lesson",
    entityId: savedId,
    userId: me.actor.id,
    metadata: { outlineId: plan.id, created },
  });
  touched(plan.id);
  return { ok: t(created ? "done.lessonAdded" : "done.lessonSaved") };
}

export async function deleteLessonAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;
  const lessonId = text(fd, "lessonId");
  if (!isUuid(lessonId)) return { error: t("errors.notFound") };

  const deleted = await db.transaction(async (tx): Promise<boolean | typeof LOCKED> => {
    if (!(await lockEditablePlan(tx, plan.id))) return LOCKED;
    const [row] = await tx
      .delete(outlineLessons)
      .where(and(eq(outlineLessons.id, lessonId), eq(outlineLessons.outlineId, plan.id)))
      .returning({ id: outlineLessons.id });
    if (!row) return false;
    await renumberLessons(tx, plan.id);
    await syncSessionsCount(tx, plan.id);
    return true;
  });
  if (deleted === LOCKED) return { error: t("errors.locked") };
  if (!deleted) return { error: t("errors.notFound") };
  await recordAudit({
    action: "teaching.lesson.deleted",
    entityType: "outline_lesson",
    entityId: lessonId,
    userId: me.actor.id,
    metadata: { outlineId: plan.id },
  });
  touched(plan.id);
  return { ok: t("done.lessonDeleted") };
}

/** Swap a lesson with the one before ("up") or after ("down") it. */
export async function moveLessonAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;
  const lessonId = text(fd, "lessonId");
  const direction = text(fd, "direction");
  if (!isUuid(lessonId) || (direction !== "up" && direction !== "down")) return { error: t("errors.notFound") };

  const moved = await db.transaction(async (tx): Promise<{ from: number; to: number } | typeof LOCKED | null> => {
    if (!(await lockEditablePlan(tx, plan.id))) return LOCKED;
    const [lesson] = await tx
      .select({ id: outlineLessons.id, sequence: outlineLessons.sequence })
      .from(outlineLessons)
      .where(and(eq(outlineLessons.id, lessonId), eq(outlineLessons.outlineId, plan.id)))
      .limit(1);
    if (!lesson) return null;
    const [neighbour] = await tx
      .select({ id: outlineLessons.id, sequence: outlineLessons.sequence })
      .from(outlineLessons)
      .where(
        and(
          eq(outlineLessons.outlineId, plan.id),
          direction === "up" ? lt(outlineLessons.sequence, lesson.sequence) : gt(outlineLessons.sequence, lesson.sequence),
        ),
      )
      .orderBy(direction === "up" ? desc(outlineLessons.sequence) : asc(outlineLessons.sequence))
      .limit(1);
    if (!neighbour) return { from: lesson.sequence, to: lesson.sequence };
    // Through a free number: the (outline, sequence) index is checked row by row.
    const [last] = await tx.select({ m: max(outlineLessons.sequence) }).from(outlineLessons).where(eq(outlineLessons.outlineId, plan.id));
    await tx.update(outlineLessons).set({ sequence: (last?.m ?? 0) + 1 }).where(eq(outlineLessons.id, lesson.id));
    await tx.update(outlineLessons).set({ sequence: lesson.sequence }).where(eq(outlineLessons.id, neighbour.id));
    await tx.update(outlineLessons).set({ sequence: neighbour.sequence }).where(eq(outlineLessons.id, lesson.id));
    return { from: lesson.sequence, to: neighbour.sequence };
  });
  if (moved === LOCKED) return { error: t("errors.locked") };
  if (!moved) return { error: t("errors.notFound") };
  if (moved.from !== moved.to) {
    await recordAudit({
      action: "teaching.lesson.moved",
      entityType: "outline_lesson",
      entityId: lessonId,
      userId: me.actor.id,
      metadata: { outlineId: plan.id, from: moved.from, to: moved.to },
    });
  }
  touched(plan.id);
  return undefined;
}

/** "Start my plan from this outline": copy a programme outline and its lessons into a new plan of hers. */
export async function copyOutlineAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const sourceId = text(fd, "sourceId");
  if (!isUuid(sourceId)) return { error: t("errors.notFound") };
  const [source] = await db.select().from(courseOutlines).where(eq(courseOutlines.id, sourceId)).limit(1);
  // Programme outlines only: another teacher's plan is not hers to copy.
  if (!source || source.ownerTeacherId !== null || source.approvalStatus !== "approved") return { error: t("errors.notFound") };

  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [plan] = await tx
        .insert(courseOutlines)
        .values({
          subjectId: source.subjectId,
          grade: source.grade,
          term: source.term,
          name: source.name,
          weeks: source.weeks,
          learningOutcomes: source.learningOutcomes,
          ownerTeacherId: me.teacher.id,
          approvalStatus: "draft",
          status: "planned",
          sessionsCount: 0,
        })
        .returning({ id: courseOutlines.id });
      const lessons = await tx
        .select()
        .from(outlineLessons)
        .where(eq(outlineLessons.outlineId, source.id))
        .orderBy(asc(outlineLessons.sequence));
      if (lessons.length > 0) {
        await tx.insert(outlineLessons).values(
          lessons.map((l, i) => ({
            outlineId: plan!.id,
            sequence: i + 1,
            title: l.title,
            week: l.week,
            objectives: l.objectives,
            activities: l.activities,
            materials: l.materials,
          })),
        );
      }
      await syncSessionsCount(tx, plan!.id);
      return plan!.id;
    });
  } catch (err) {
    if (uniqueViolation(err)) return { error: t("errors.planExists") };
    throw err;
  }
  const [lessonCount] = await db.select({ c: count() }).from(outlineLessons).where(eq(outlineLessons.outlineId, id));
  await recordAudit({
    action: "teaching.plan.created",
    entityType: "course_outline",
    entityId: id,
    userId: me.actor.id,
    metadata: { subjectId: source.subjectId, grade: source.grade, term: source.term, copiedFrom: source.id, lessonCount: lessonCount?.c ?? 0 },
  });
  revalidatePath("/teaching/plans");
  redirect(`/teaching/plans/${id}`);
}

/** Send her plan for approval, with an optional note. It needs at least one lesson. */
export async function submitPlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const plan = await editablePlan(t, me.teacher, fd);
  if ("error" in plan) return plan;
  const [lessons] = await db.select({ c: count() }).from(outlineLessons).where(eq(outlineLessons.outlineId, plan.id));
  if ((lessons?.c ?? 0) === 0) return { error: t("errors.planNeedsLessons") };

  const sent = await submitForApproval(db, { itemType: "lesson_plan", itemId: plan.id, actor: me.actor, note: text(fd, "note").slice(0, 1000) });
  if (!sent.ok) return { error: t(sent.error === "already_pending" ? "errors.alreadyPending" : "errors.locked") };
  touched(plan.id);
  revalidatePath("/teaching");
  return { ok: t("done.submitted") };
}
