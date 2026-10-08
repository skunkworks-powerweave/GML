"use server";

// Upload her students as a CSV ("My students"; the template is
// /api/teaching/students/template). The classes a row may name are HER class
// links and nothing else, and the school and grade of every new student come
// from the class (lib/teaching/students-csv.ts). A row that cannot be added is
// reported by line and the rest land. Names are PII (SM-9): the audit row
// carries counts and class ids, never a name.

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { learners } from "@gml/db/schema";
import { recordAudit } from "@/lib/audit";
import { myClassLinks } from "@/lib/teaching";
import { signedInTeacher } from "@/lib/teaching/current";
import { failureText, issueLines, parseCsv, readUpload } from "@/lib/teaching/csv";
import { STUDENT_COLUMNS, studentsFromRows } from "@/lib/teaching/students-csv";
import type { ActionState } from "@/lib/teaching/forms";

export async function uploadStudentsCsvAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const t = await getTranslations("teaching");
  const me = await signedInTeacher();
  if ("refused" in me) return { error: t(`errors.${me.refused}`) };
  const links = await myClassLinks(db, me.teacher.id);
  if (links.length === 0) return { error: t("students.noClasses") };

  const upload = await readUpload(fd);
  if ("failure" in upload) return { error: failureText(t, upload.failure) };
  const csv = parseCsv(upload.text, STUDENT_COLUMNS);
  if ("failure" in csv) return { error: failureText(t, csv.failure) };
  if (!csv.present.has("name")) return { error: t("csv.missingColumn", { column: "name" }) };
  // With several classes a row has to say which; with one it need not.
  if (!csv.present.has("class") && new Set(links.map((l) => l.classId)).size > 1) return { error: t("csv.missingColumn", { column: "class" }) };

  const { students, problems } = await studentsFromRows(db, t, links, csv.rows);
  const issues = issueLines(t, problems);
  if (students.length === 0) return { error: t("csv.nothingImported"), issues };

  try {
    await db.insert(learners).values(
      students.map(({ line: _line, ...s }) => s),
    );
  } catch (err) {
    // Not a row's fault (the connection): nothing was added. The driver text goes to the log, not to her.
    console.error("[teaching.students.imported] failed", err);
    return { error: t("csv.failed") };
  }
  await recordAudit({
    action: "teaching.students.imported",
    entityType: "teacher",
    entityId: me.teacher.id,
    userId: me.actor.id,
    metadata: { rows: csv.rows.length, created: students.length, rejected: problems.length, classIds: [...new Set(students.map((s) => s.classId))] },
  });
  revalidatePath("/teaching/students");
  revalidatePath("/teaching");
  const done = t("done.studentsUploaded", { count: students.length });
  return { ok: problems.length > 0 ? `${done} ${t("done.csvSkipped", { count: problems.length })}` : done, issues };
}
