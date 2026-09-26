// Whether a quiz is one the viewer is shown (W3-21).
//
// lib/rtt/scope.ts is the ONE predicate for which RTT subjects a viewer is
// shown: a retired subject is hidden from everyone but an administrator, and
// a subject taught to one district or zone from teachers elsewhere. /rtt, the
// subject page and the open-assessment list all apply it, so none of them
// offers such a subject's quiz -- but the quiz routes looked the quiz up by
// slug and checked only quizzes.active. A direct link (a WhatsApp share, an
// old bookmark) still opened the runner and recorded attempts and passes on a
// subject the programme had withdrawn, or one taught somewhere else.
//
// A quiz on a curriculum subject (no rtt_subject_id) is outside RTT's scoping
// and stays as it was.

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rttSubjects } from "@gml/db/schema";
import { rttScope } from "@/lib/rtt/scope";
import type { Actor } from "@/lib/visibility";

type Db = NodePgDatabase<Record<string, unknown>>;

export async function quizShownTo(db: Db, actor: Actor, quiz: { rttSubjectId: string | null }): Promise<boolean> {
  if (!quiz.rttSubjectId) return true;
  const scope = await rttScope(db, actor);
  const [subject] = await db
    .select({ id: rttSubjects.id })
    .from(rttSubjects)
    .where(and(eq(rttSubjects.id, quiz.rttSubjectId), scope.subjectWhere))
    .limit(1);
  return Boolean(subject);
}
