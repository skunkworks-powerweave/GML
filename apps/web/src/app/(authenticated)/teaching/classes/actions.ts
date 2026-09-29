"use server";

// "My classes": a teacher links herself to a class of HER school (a grade, and
// optionally one section and the subject she teaches it), and removes a link.
//
// The grade's classes row is the school's, shared by every teacher who teaches
// that grade there: adding a class reuses it, or creates it when the school has
// none yet (lib/teaching/records ensureClass). Removing a link never removes
// the class, its students or its sessions -- only her link to it.
//
// Ownership: the school is always hers (from her teachers row, never from the
// form), and a link is removed only when it is hers. Every write is audited
// (docs/audit-actions.md, teaching.*).

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { teacherClasses } from "@gml/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { signedInTeacher } from "@/lib/teaching/current";
import { ensureClass, parseSection, subjectExists, text, wholeNumber } from "@/lib/teaching/records";
import type { ActionState } from "@/lib/teaching/forms";

function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export async function addClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };

  const grade = wholeNumber(text(fd, "grade"), 1, 12);
  if (grade == null || Number.isNaN(grade)) return { error: t("errors.gradeInvalid") };
  const section = parseSection(text(fd, "section"));
  if (section === undefined) return { error: t("errors.sectionInvalid") };
  const subjectRaw = text(fd, "subjectId");
  const subjectId = subjectRaw === "" ? null : subjectRaw;
  if (subjectId !== null && !(isUuid(subjectId) && (await subjectExists(db, subjectId)))) {
    return { error: t("errors.subjectInvalid") };
  }

  let linkId: string;
  let classId: string;
  let classCreated: boolean;
  try {
    ({ linkId, classId, classCreated } = await db.transaction(async (tx) => {
      const cls = await ensureClass(tx, me.teacher.schoolId, grade);
      const [link] = await tx
        .insert(teacherClasses)
        .values({ teacherId: me.teacher.id, classId: cls.id, section, subjectId })
        .returning({ id: teacherClasses.id });
      return { linkId: link!.id, classId: cls.id, classCreated: cls.created };
    }));
  } catch (err) {
    if (uniqueViolation(err)) return { error: t("errors.alreadyLinked") };
    throw err;
  }

  await recordAudit({
    action: "teaching.class.linked",
    entityType: "teacher_class",
    entityId: linkId,
    userId: me.actor.id,
    metadata: { classId, grade, section, subjectId, classCreated },
  });
  revalidatePath("/teaching/classes");
  revalidatePath("/teaching");
  return { ok: t("done.classAdded") };
}

export async function removeClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };

  const linkId = text(fd, "linkId");
  if (!isUuid(linkId)) return { error: t("errors.notFound") };
  // Hers only: the teacher_id condition is part of the DELETE itself.
  const [gone] = await db
    .delete(teacherClasses)
    .where(and(eq(teacherClasses.id, linkId), eq(teacherClasses.teacherId, me.teacher.id)))
    .returning({ classId: teacherClasses.classId, section: teacherClasses.section });
  if (!gone) return { error: t("errors.notFound") };

  await recordAudit({
    action: "teaching.class.unlinked",
    entityType: "teacher_class",
    entityId: linkId,
    userId: me.actor.id,
    metadata: { classId: gone.classId, section: gone.section },
  });
  revalidatePath("/teaching/classes");
  revalidatePath("/teaching");
  return { ok: t("done.classRemoved") };
}
