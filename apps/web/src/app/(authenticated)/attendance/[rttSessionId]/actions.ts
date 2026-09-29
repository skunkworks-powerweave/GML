"use server";

// Save the attendance marks taken of teachers at one RTT session.
//
// The page's form posts one radio group per teacher (status:<teacherId> =
// present / late / absent / excused) and one of two buttons: Save, or Mark
// all present, which also marks everyone left unmarked present. Who may, and
// what is written, is decided here, not by the form: programme admins and
// super admins only (requireRole), teachers on the session's roster only, and
// each changed mark stamped with who took it and when (lib/rtt/attendance.ts
// markAttendance). A plain <form> posts here, so it works with no client
// JavaScript on a slow link; the redirect says how many marks changed.

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { db } from "@gml/db";
import { recordAudit } from "@/lib/audit";
import { requireRole } from "@/lib/guards";
import { isUuid } from "@/lib/ids";
import { isAttendanceStatus, markAttendance } from "@/lib/rtt/attendance";
import type { AttendanceStatus } from "@/lib/rtt/progress";

const FIELD = "status:";

export async function saveAttendanceAction(formData: FormData): Promise<void> {
  const session = await requireRole(["programme_admin", "super_admin"]);
  const sessionId = formData.get("rttSessionId");
  if (!isUuid(sessionId)) notFound();
  const back = `/attendance/${sessionId}`;

  const marks = new Map<string, AttendanceStatus>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(FIELD)) continue;
    const teacherId = key.slice(FIELD.length);
    // The form offers these values only: anything else is a crafted post.
    if (!isUuid(teacherId) || !isAttendanceStatus(value)) redirect(`${back}?error=invalid`);
    marks.set(teacherId, value);
  }
  const allPresent = formData.get("intent") === "all_present";

  const result = await markAttendance(db, { sessionId, marks, fillPresent: allPresent, actorId: session.user.id });
  if (!result.ok) {
    if (result.error === "not_found") notFound();
    redirect(`${back}?error=${result.error}`);
  }

  if (result.changed > 0) {
    await recordAudit({
      action: "rtt.attendance.marked",
      entityType: "rtt_session",
      entityId: sessionId,
      userId: session.user.id,
      metadata: { changed: result.changed, counts: result.counts, allPresent },
    });
  }

  revalidatePath(back);
  revalidatePath("/attendance");
  redirect(`${back}?saved=${result.changed}`);
}
