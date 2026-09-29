"use server";

// A teacher's own classroom sessions, their attendance, and sending them for
// approval.
//
//   create / edit   one of HER classes (a class link, plus a section when the
//                   link covers the whole grade), a subject, optionally a
//                   lesson of her plans or the programme's outline for that
//                   subject and grade, date, time, duration, topic, notes and
//                   status. A new session is a draft (approval_status).
//   attendance      her roster for the session's class and section, each
//                   student present / absent / late / excused (default
//                   present). One transaction upserts session_attendance and
//                   writes the session's attended (present + late) and total
//                   counts, and each student's attendance %.
//   submit          lib/approvals, item type "session": once pending or
//                   approved the session AND its attendance are locked.
//
// Every write needs the session to be hers (lib/teaching ownsSession) and
// still editable (lib/approvals isEditable). Audited under teaching.*.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { count, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { sessionAttendance, sessions } from "@gml/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { isEditable, submitForApproval } from "@/lib/approvals";
import { ownsSession, roster, type MyTeacher } from "@/lib/teaching";
import { signedInTeacher } from "@/lib/teaching/current";
import {
  ATTENDANCE_STATUSES,
  lessonFits,
  linkOf,
  lockEditableSession,
  parseDate,
  parseSection,
  parseTime,
  recomputeSessionCounts,
  refreshLearnerAttendance,
  SESSION_STATUSES,
  sessionSubmitBlocker,
  subjectExists,
  text,
  wholeNumber,
  type AttendanceStatus,
  type SessionStatus,
} from "@/lib/teaching/records";
import type { ActionState } from "@/lib/teaching/forms";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

type SessionFields = {
  classId: string;
  schoolId: string;
  section: string | null;
  subjectId: string;
  outlineLessonId: string | null;
  scheduledDate: string;
  scheduledTime: string | null;
  durationMin: number | null;
  topic: string | null;
  notes: string | null;
  status: SessionStatus;
};

/** The session form, validated against what is hers; or the message saying what is wrong. */
async function sessionFields(t: Translate, teacher: MyTeacher, fd: FormData): Promise<SessionFields | { error: string }> {
  const linkId = text(fd, "linkId");
  const link = isUuid(linkId) ? await linkOf(db, teacher.id, linkId) : null;
  if (!link) return { error: t("errors.classInvalid") };
  const typed = parseSection(text(fd, "section"));
  if (typed === undefined) return { error: t("errors.sectionInvalid") };
  const section = link.section ?? typed;

  const subjectId = text(fd, "subjectId");
  if (!isUuid(subjectId) || !(await subjectExists(db, subjectId))) return { error: t("errors.subjectRequired") };

  const lessonRaw = text(fd, "lessonId");
  const outlineLessonId = lessonRaw === "" ? null : lessonRaw;
  if (outlineLessonId !== null && !(isUuid(outlineLessonId) && (await lessonFits(db, teacher.id, outlineLessonId, subjectId, link.grade)))) {
    return { error: t("errors.lessonInvalid") };
  }

  const scheduledDate = parseDate(text(fd, "date"));
  if (!scheduledDate) return { error: t("errors.dateInvalid") };
  const timeRaw = text(fd, "time");
  const scheduledTime = timeRaw === "" ? null : parseTime(timeRaw);
  if (timeRaw !== "" && !scheduledTime) return { error: t("errors.timeInvalid") };
  const durationMin = wholeNumber(text(fd, "durationMin"), 1, 600);
  if (Number.isNaN(durationMin)) return { error: t("errors.durationInvalid") };

  const topic = text(fd, "topic");
  if (topic.length > 240) return { error: t("errors.tooLong", { field: t("fields.topic"), max: 240 }) };
  const notes = text(fd, "notes");
  if (notes.length > 4000) return { error: t("errors.tooLong", { field: t("fields.notes"), max: 4000 }) };
  const statusRaw = text(fd, "status") || "planned";
  if (!(SESSION_STATUSES as readonly string[]).includes(statusRaw)) return { error: t("errors.statusInvalid") };

  return {
    classId: link.classId,
    schoolId: link.schoolId,
    section,
    subjectId,
    outlineLessonId,
    scheduledDate,
    scheduledTime,
    durationMin,
    topic: topic || null,
    notes: notes || null,
    status: statusRaw as SessionStatus,
  };
}

type Editable = { id: string; classId: string; section: string | null; status: string };

/** Her session named by the form's `id`, while she may still change it; otherwise the refusal. */
async function editableSession(t: Translate, teacher: MyTeacher, fd: FormData): Promise<Editable | { error: string }> {
  const id = text(fd, "id");
  if (!isUuid(id) || !(await ownsSession(db, teacher.id, id))) return { error: t("errors.notFound") };
  const [row] = await db
    .select({ id: sessions.id, classId: sessions.classId, section: sessions.section, status: sessions.status, state: sessions.approvalStatus })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row || !isEditable(row.state)) return { error: t("errors.locked") };
  return row;
}

function touched(id: string) {
  revalidatePath(`/teaching/sessions/${id}`);
  revalidatePath("/teaching/sessions");
  revalidatePath("/teaching");
}

export async function createSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const fields = await sessionFields(t, me.teacher, fd);
  if ("error" in fields) return fields;

  const [row] = await db
    .insert(sessions)
    .values({ ...fields, teacherId: me.teacher.id, approvalStatus: "draft" })
    .returning({ id: sessions.id });
  await recordAudit({
    action: "teaching.session.created",
    entityType: "session",
    entityId: row!.id,
    userId: me.actor.id,
    metadata: { classId: fields.classId, subjectId: fields.subjectId, scheduledDate: fields.scheduledDate },
  });
  revalidatePath("/teaching/sessions");
  revalidatePath("/teaching");
  redirect(`/teaching/sessions/${row!.id}`);
}

export async function updateSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const current = await editableSession(t, me.teacher, fd);
  if ("error" in current) return current;
  const fields = await sessionFields(t, me.teacher, fd);
  if ("error" in fields) return fields;

  // Attendance is taken against the class's roster: once it is, the session
  // stays with that class and section.
  if (fields.classId !== current.classId || fields.section !== current.section) {
    const [marked] = await db.select({ c: count() }).from(sessionAttendance).where(eq(sessionAttendance.sessionId, current.id));
    if ((marked?.c ?? 0) > 0) return { error: t("errors.classFixedAfterAttendance") };
  }
  const done = await db.transaction(async (tx) => {
    if (!(await lockEditableSession(tx, current.id))) return false;
    await tx
      .update(sessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(sessions.id, current.id));
    // A cancelled session does not count towards a student's attendance %:
    // cancelling one (or taking that back) changes the % of everyone marked in it.
    if (fields.status !== current.status && (fields.status === "cancelled" || current.status === "cancelled")) {
      const marked = await tx.select({ id: sessionAttendance.learnerId }).from(sessionAttendance).where(eq(sessionAttendance.sessionId, current.id));
      await refreshLearnerAttendance(
        tx,
        marked.map((m) => m.id),
      );
    }
    return true;
  });
  if (!done) return { error: t("errors.locked") };
  await recordAudit({
    action: "teaching.session.updated",
    entityType: "session",
    entityId: current.id,
    userId: me.actor.id,
    metadata: { classId: fields.classId, subjectId: fields.subjectId, scheduledDate: fields.scheduledDate, status: fields.status },
  });
  touched(current.id);
  return { ok: t("done.sessionSaved") };
}

/**
 * Save the attendance of her session. The roster comes from the database, not
 * the form: a learner id that is not on it is ignored, and one missing from the
 * form is marked present. `intent=all_present` marks everyone present.
 */
export async function saveAttendanceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const s = await editableSession(t, me.teacher, fd);
  if ("error" in s) return s;
  if (s.status === "cancelled") return { error: t("errors.cancelledNoAttendance") };

  const students = await roster(db, s.classId, s.section);
  if (students.length === 0) return { error: t("errors.noStudents") };
  const allPresent = text(fd, "intent") === "all_present";
  const marks = students.map((st) => {
    const raw = text(fd, `status_${st.id}`);
    const status: AttendanceStatus =
      !allPresent && (ATTENDANCE_STATUSES as readonly string[]).includes(raw) ? (raw as AttendanceStatus) : "present";
    return { learnerId: st.id, status };
  });

  const now = new Date();
  const counts = await db.transaction(async (tx) => {
    if (!(await lockEditableSession(tx, s.id))) return null;
    for (const m of marks) {
      await tx
        .insert(sessionAttendance)
        .values({ sessionId: s.id, learnerId: m.learnerId, status: m.status, markedByUserId: me.actor.id, markedAt: now })
        .onConflictDoUpdate({
          target: [sessionAttendance.sessionId, sessionAttendance.learnerId],
          set: { status: m.status, markedByUserId: me.actor.id, markedAt: now },
        });
    }
    const c = await recomputeSessionCounts(tx, s.id);
    await refreshLearnerAttendance(
      tx,
      marks.map((m) => m.learnerId),
    );
    return c;
  });
  if (!counts) return { error: t("errors.locked") };

  const tally = Object.fromEntries(ATTENDANCE_STATUSES.map((k) => [k, marks.filter((m) => m.status === k).length])) as Record<
    AttendanceStatus,
    number
  >;
  await recordAudit({
    action: "teaching.attendance.saved",
    entityType: "session",
    entityId: s.id,
    userId: me.actor.id,
    metadata: { ...tally, attended: counts.attended, total: counts.total },
  });
  touched(s.id);
  return { ok: t("done.attendanceSaved", { attended: counts.attended, total: counts.total }) };
}

/**
 * Send her session, with its attendance, for approval. A session is sent once
 * it has happened: complete (with attendance taken, when the class has
 * students) or cancelled.
 */
export async function submitSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const s = await editableSession(t, me.teacher, fd);
  if ("error" in s) return s;
  const block = await sessionSubmitBlocker(db, s);
  if (block) return { error: t(`errors.${block}`) };

  const sent = await submitForApproval(db, { itemType: "session", itemId: s.id, actor: me.actor, note: text(fd, "note").slice(0, 1000) });
  if (!sent.ok) return { error: t(sent.error === "already_pending" ? "errors.alreadyPending" : "errors.locked") };
  touched(s.id);
  return { ok: t("done.submitted") };
}
