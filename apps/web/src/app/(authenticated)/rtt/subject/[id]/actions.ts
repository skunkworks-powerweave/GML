"use server";

// Mark an RTT lesson or reading done (or not) for the signed-in learner.
//
// The subject page had no completion state at all (F36): "Resume" always went
// to module 1 and nothing a learner did was kept. rtt_progress holds one row
// per learner per lesson or reading ticked; lib/rtt/progress.ts reads it.
//
// A plain <form> posts here, so it works with no client JavaScript on a slow
// link, and the redirect lands back on the item that was ticked.

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { rttLessons, rttModules, rttProgress, rttReadings, rttSubjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { isUuid } from "@/lib/ids";
import { rttScope } from "@/lib/rtt/scope";

export async function markProgressAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const kind = formData.get("kind");
  const itemId = formData.get("itemId");
  const done = formData.get("done") === "true";
  if ((kind !== "lesson" && kind !== "reading") || !isUuid(itemId)) notFound();

  // Resolve the item to its subject (and a lesson to its module, for the
  // anchor). An id of the wrong kind resolves to nothing.
  let subjectId: string;
  let back: string;
  if (kind === "lesson") {
    const [row] = await db
      .select({ subjectId: rttModules.rttSubjectId, sequence: rttModules.sequence })
      .from(rttLessons)
      .innerJoin(rttModules, eq(rttModules.id, rttLessons.rttModuleId))
      .where(eq(rttLessons.id, itemId))
      .limit(1);
    if (!row) notFound();
    subjectId = row.subjectId;
    back = `/rtt/subject/${subjectId}?open=${row.sequence}#module-${row.sequence}`;
  } else {
    const [row] = await db
      .select({ subjectId: rttReadings.rttSubjectId })
      .from(rttReadings)
      .where(eq(rttReadings.id, itemId))
      .limit(1);
    if (!row) notFound();
    subjectId = row.subjectId;
    back = `/rtt/subject/${subjectId}#readings`;
  }

  // Only on a subject she is shown (lib/rtt/scope.ts), as the page is.
  const scope = await rttScope(db, { id: userId, role: session.user.role });
  const [shown] = await db
    .select({ id: rttSubjects.id })
    .from(rttSubjects)
    .where(and(eq(rttSubjects.id, subjectId), scope.subjectWhere))
    .limit(1);
  if (!shown) notFound();

  const item = kind === "lesson" ? { rttLessonId: itemId } : { rttReadingId: itemId };
  const column = kind === "lesson" ? rttProgress.rttLessonId : rttProgress.rttReadingId;
  if (done) {
    // A second tick (a double tap, a resubmitted form) is the same fact, not
    // an error: the partial unique indexes make it a no-op.
    await db.insert(rttProgress).values({ userId, ...item }).onConflictDoNothing();
  } else {
    await db.delete(rttProgress).where(and(eq(rttProgress.userId, userId), eq(column, itemId)));
  }

  revalidatePath(`/rtt/subject/${subjectId}`);
  revalidatePath("/rtt/progress");
  redirect(back);
}
