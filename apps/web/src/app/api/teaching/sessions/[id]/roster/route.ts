// GET /api/teaching/sessions/[id]/roster -> the roster of one of HER sessions as
// a CSV to fill in (student, rollNumber, section, and a blank status), which
// she uploads back on the session page.
//
//   not signed in            401
//   not a teacher            403 (approvers keep the admin CSV; mentors and
//                            observers have no business with a roster)
//   not hers, or no such     404, the same answer for both
//   session
//   locked or cancelled      409: the page offers no roster either, and a
//                            session that can no longer take attendance has
//                            nothing to fill in
//
// The roster names children (SM-9): the download is audited as every learner
// list is (teaching.students.viewed), and the file is never cached.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, sessions } from "@gml/db/schema";
import { requireApiRole } from "@/lib/api-guards";
import { recordAudit } from "@/lib/audit";
import { actorFrom } from "@/lib/visibility";
import { myTeacher, roster } from "@/lib/teaching";
import { ROSTER_COLUMNS, rosterFilename } from "@/lib/teaching/attendance-csv";
import { csvDownload } from "@/lib/teaching/csv";
import { editableSessionOf } from "@/lib/teaching/records";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireApiRole(["teacher"]);
  if (gate.response) return gate.response;
  const actor = actorFrom(gate.session)!;
  const teacher = await myTeacher(db, actor);
  const found = teacher ? await editableSessionOf(db, teacher.id, (await ctx.params).id) : "notFound";
  if (found === "notFound") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (found === "locked" || found.status === "cancelled") return NextResponse.json({ error: "not_editable" }, { status: 409 });

  const students = await roster(db, found.classId, found.section);
  const [when] = await db
    .select({ grade: classes.grade, date: sessions.scheduledDate })
    .from(sessions)
    .innerJoin(classes, eq(classes.id, sessions.classId))
    .where(eq(sessions.id, found.id))
    .limit(1);
  await recordAudit({
    action: "teaching.students.viewed",
    entityType: "session",
    entityId: found.id,
    userId: actor.id,
    metadata: { page: "roster_csv", rowCount: students.length },
  });
  return csvDownload(
    rosterFilename(when!.grade, found.section, when!.date),
    ROSTER_COLUMNS,
    students.map((s) => ({ student: s.name, rollNumber: s.rollNumber ?? "", section: s.section ?? "", status: "" })),
  );
}
