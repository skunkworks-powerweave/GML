"use server";

// "My students": a teacher adds, edits and removes the learners of the classes
// she teaches -- and of no others.
//
//   add      into one of HER class links; the section is the link's when it
//            names one, else what she typed (or none)
//   edit     a learner of her roster (lib/teaching/records studentOf); moving
//            the learner to another section needs that section to be hers too
//   remove   soft: deleted_at is set, so the learner leaves every roster and
//            her attendance and marks history stays
//
// Names, guardians and ages are PII (SM-9): the audit rows carry ids and which
// fields changed, never the values.

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { learners } from "@gml/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { classPlacement } from "@/lib/learner-placement";
import { teachesClass } from "@/lib/teaching";
import { signedInTeacher } from "@/lib/teaching/current";
import { linkOf, parseSection, studentOf, text, wholeNumber } from "@/lib/teaching/records";
import type { ActionState } from "@/lib/teaching/forms";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

type Fields = { name: string; rollNumber: string | null; age: number | null; guardian: string | null };

/** The fields every student form carries, validated; or the message saying what is wrong. */
function studentFields(t: Translate, fd: FormData): Fields | { error: string } {
  const name = text(fd, "name");
  if (!name) return { error: t("errors.nameRequired") };
  if (name.length > 160) return { error: t("errors.tooLong", { field: t("fields.name"), max: 160 }) };
  const roll = text(fd, "rollNumber");
  if (roll.length > 32) return { error: t("errors.tooLong", { field: t("fields.rollNumber"), max: 32 }) };
  const guardian = text(fd, "guardian");
  if (guardian.length > 120) return { error: t("errors.tooLong", { field: t("fields.guardian"), max: 120 }) };
  const age = wholeNumber(text(fd, "age"), 3, 25);
  if (Number.isNaN(age)) return { error: t("errors.ageInvalid") };
  return { name, rollNumber: roll || null, age, guardian: guardian || null };
}

export async function addStudentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };

  const linkId = text(fd, "linkId");
  const link = isUuid(linkId) ? await linkOf(db, me.teacher.id, linkId) : null;
  if (!link) return { error: t("errors.classInvalid") };
  const typed = parseSection(text(fd, "section"));
  if (typed === undefined) return { error: t("errors.sectionInvalid") };
  // A link to section A puts the student in section A, whatever was typed.
  const section = link.section ?? typed;
  const fields = studentFields(t, fd);
  if ("error" in fields) return fields;

  // The school and grade are the class's, never typed: lib/learner-placement.ts.
  const cls = await classPlacement(db, link.classId);
  if (!cls) return { error: t("errors.classInvalid") };
  const [row] = await db
    .insert(learners)
    .values({ classId: link.classId, schoolId: cls.schoolId, grade: cls.grade, section, ...fields })
    .returning({ id: learners.id });

  await recordAudit({
    action: "teaching.student.created",
    entityType: "learner",
    entityId: row!.id,
    userId: me.actor.id,
    metadata: { classId: link.classId, section },
  });
  revalidatePath("/teaching/students");
  revalidatePath("/teaching");
  return { ok: t("done.studentAdded", { name: fields.name }) };
}

export async function updateStudentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };

  const learnerId = text(fd, "learnerId");
  const student = isUuid(learnerId) ? await studentOf(db, me.teacher.id, learnerId) : null;
  if (!student) return { error: t("errors.notFound") };
  const section = parseSection(text(fd, "section"));
  if (section === undefined) return { error: t("errors.sectionInvalid") };
  if (section !== student.section && !(await teachesClass(db, me.teacher.id, student.classId, section))) {
    return { error: t("errors.sectionNotYours") };
  }
  const fields = studentFields(t, fd);
  if ("error" in fields) return fields;

  const before: Record<string, unknown> = { ...student };
  const after: Record<string, unknown> = { ...fields, section };
  const changed = Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
  if (changed.length > 0) {
    await db
      .update(learners)
      .set({ ...fields, section, updatedAt: new Date() })
      .where(eq(learners.id, student.id));
    await recordAudit({
      action: "teaching.student.updated",
      entityType: "learner",
      entityId: student.id,
      userId: me.actor.id,
      metadata: { classId: student.classId, changed },
    });
  }
  revalidatePath("/teaching/students");
  return { ok: t("done.studentSaved", { name: fields.name }) };
}

export async function removeStudentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };

  const learnerId = text(fd, "learnerId");
  const student = isUuid(learnerId) ? await studentOf(db, me.teacher.id, learnerId) : null;
  if (!student) return { error: t("errors.notFound") };
  await db.update(learners).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(learners.id, student.id));

  await recordAudit({
    action: "teaching.student.removed",
    entityType: "learner",
    entityId: student.id,
    userId: me.actor.id,
    metadata: { classId: student.classId },
  });
  revalidatePath("/teaching/students");
  revalidatePath("/teaching");
  return { ok: t("done.studentRemoved", { name: student.name }) };
}
