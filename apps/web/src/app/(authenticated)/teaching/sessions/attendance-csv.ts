"use server";

// Upload one of her sessions' attendance as a CSV (the page also offers the
// roster to download: /api/teaching/sessions/[id]/roster).
//
// The same rules as marking on the page: the session is hers, not cancelled
// and still editable; students are found only on its roster
// (lib/teaching/attendance-csv.ts); the marks are written, and the session's
// counts and each student's attendance % recomputed, by the one function the
// roster form uses (records.ts saveSessionMarks). What differs: a student the
// file leaves out is left as she was, and a row that cannot be used is reported
// by line while the others land.

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { recordAudit } from "@/lib/audit";
import { roster } from "@/lib/teaching";
import { signedInTeacher } from "@/lib/teaching/current";
import { ATTENDANCE_COLUMNS, marksFromRows } from "@/lib/teaching/attendance-csv";
import { failureText, issueLines, parseCsv, readUpload } from "@/lib/teaching/csv";
import { ATTENDANCE_STATUSES, editableSessionOf, saveSessionMarks, text } from "@/lib/teaching/records";
import type { ActionState } from "@/lib/teaching/forms";

export async function uploadAttendanceCsvAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const s = await editableSessionOf(db, me.teacher.id, text(fd, "id"));
  if (s === "notFound") return { error: t("errors.notFound") };
  if (s === "locked") return { error: t("errors.locked") };
  if (s.status === "cancelled") return { error: t("errors.cancelledNoAttendance") };

  const upload = await readUpload(fd);
  if ("failure" in upload) return { error: failureText(t, upload.failure) };
  const csv = parseCsv(upload.text, ATTENDANCE_COLUMNS);
  if ("failure" in csv) return { error: failureText(t, csv.failure) };
  if (!csv.present.has("status")) return { error: t("csv.missingColumn", { column: "status" }) };
  if (!csv.present.has("student") && !csv.present.has("rollNumber")) return { error: t("csv.missingColumn", { column: "student / rollNumber" }) };

  const students = await roster(db, s.classId, s.section);
  if (students.length === 0) return { error: t("errors.noStudents") };
  const { marks, problems } = marksFromRows(t, students, csv.rows);
  const issues = issueLines(t, problems);
  if (marks.length === 0) return { error: t("csv.nothingImported"), issues };

  const counts = await saveSessionMarks(db, s.id, me.actor.id, marks);
  if (!counts) return { error: t("errors.locked") };

  await recordAudit({
    action: "teaching.attendance.imported",
    entityType: "session",
    entityId: s.id,
    userId: me.actor.id,
    metadata: {
      rows: csv.rows.length,
      marked: marks.length,
      rejected: problems.length,
      ...Object.fromEntries(ATTENDANCE_STATUSES.map((k) => [k, marks.filter((m) => m.status === k).length])),
      attended: counts.attended,
      total: counts.total,
    },
  });
  revalidatePath(`/teaching/sessions/${s.id}`);
  revalidatePath("/teaching/sessions");
  revalidatePath("/teaching");
  const done = t("done.attendanceUploaded", { marked: marks.length, attended: counts.attended, total: counts.total });
  return { ok: problems.length > 0 ? `${done} ${t("done.csvSkipped", { count: problems.length })}` : done, issues };
}
