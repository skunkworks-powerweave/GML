"use server";

// Server actions for /teaching/marks: a teacher's assessments and marks.
//
// Only a teacher reaches these (requireRole); lib/grading/marks.ts then
// decides whether the assessment is HERS and still editable, and whether each
// student is on its class's roster -- so a hand-made post for another
// teacher's assessment, or one that is pending or approved, is refused
// whatever the page showed. Sending for approval goes through lib/approvals.
// Answers come back as one sentence in her language (grading.marks.*).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { actorFrom, type Actor } from "@/lib/visibility";
import { isUuid } from "@/lib/ids";
import { submitForApproval } from "@/lib/approvals";
import {
  assessmentAccess,
  createAssessment,
  hasMarks,
  saveMarks,
  updateAssessment,
  type AssessmentFields,
  type MarksResult,
} from "@/lib/grading/marks";
import type { FormState } from "@/app/(authenticated)/admin/grading/_ui/action-form";

const MARKS_PATH = "/teaching/marks";

async function teacherActor(): Promise<Actor> {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  return actor;
}

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "");

async function refused(result: Extract<MarksResult<unknown>, { ok: false }>): Promise<FormState> {
  const t = await getTranslations("grading");
  return { ok: false, message: t(`marks.errors.${result.error}`, result.detail ?? {}) };
}

/** The assessment's details as posted; numbers that do not parse fail validation in the library. */
function fields(fd: FormData): AssessmentFields {
  const max = text(fd, "maxMarks").trim();
  const term = text(fd, "term").trim();
  const date = text(fd, "assessedOn").trim();
  const scale = text(fd, "gradingScaleId").trim();
  return {
    title: text(fd, "title"),
    subjectId: text(fd, "subjectId"),
    maxMarks: /^\d+$/.test(max) ? Number(max) : Number.NaN,
    assessedOn: date || null,
    term: term === "" ? null : /^\d+$/.test(term) ? Number(term) : Number.NaN,
    gradingScaleId: scale || null,
  };
}

export async function createAssessmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await teacherActor();
  const result = await createAssessment(db, actor, { ...fields(fd), classKey: text(fd, "classKey") });
  if (!result.ok) return refused(result);
  revalidatePath(MARKS_PATH);
  redirect(`${MARKS_PATH}/${result.id}`);
}

export async function updateAssessmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await teacherActor();
  const id = text(fd, "assessmentId");
  const result = await updateAssessment(db, actor, id, fields(fd));
  if (!result.ok) return refused(result);
  revalidatePath(MARKS_PATH);
  revalidatePath(`${MARKS_PATH}/${id}`);
  const t = await getTranslations("grading");
  return { ok: true, message: t("marks.done.detailsSaved") };
}

export async function saveMarksAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await teacherActor();
  const id = text(fd, "assessmentId");
  const learnerIds = fd.getAll("learnerId").map(String);
  const marks = fd.getAll("marks").map(String);
  const absent = fd.getAll("absent").map(String);
  const remarks = fd.getAll("remark").map(String);
  const entries = learnerIds.map((learnerId, i) => ({
    learnerId,
    marks: marks[i] ?? "",
    absent: absent[i] === "1",
    remark: remarks[i] ?? "",
  }));
  const result = await saveMarks(db, actor, id, entries);
  if (!result.ok) return refused(result);
  revalidatePath(MARKS_PATH);
  revalidatePath(`${MARKS_PATH}/${id}`);
  const t = await getTranslations("grading");
  return { ok: true, message: t("marks.done.marksSaved", { marked: result.marked, absent: result.absent }) };
}

export async function submitAssessmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await teacherActor();
  const id = text(fd, "assessmentId");
  const t = await getTranslations("grading");
  if (!isUuid(id)) return { ok: false, message: t("marks.errors.not_found") };
  // Hers first -- another teacher learns nothing about it -- then something
  // to approve. The lock (pending, approved) is the approval handler's check.
  if ((await assessmentAccess(db, actor, id))?.mode !== "owner") return { ok: false, message: t("marks.errors.cannot_submit") };
  if (!(await hasMarks(db, id))) return { ok: false, message: t("marks.errors.no_marks") };
  const sent = await submitForApproval(db, { itemType: "assessment", itemId: id, actor, note: text(fd, "note") });
  if (!sent.ok) {
    return { ok: false, message: t(sent.error === "already_pending" ? "marks.errors.already_pending" : "marks.errors.cannot_submit") };
  }
  revalidatePath(MARKS_PATH);
  revalidatePath(`${MARKS_PATH}/${id}`);
  return { ok: true, message: t("marks.done.submitted") };
}
