// The RTT quizzes a learner is offered: per subject (the subject page's
// Assessment card) and outstanding across the programme (/rtt, and the
// dashboard's "open quizzes" to-do that links there).
//
// ── WHY BY rtt_subject_id ────────────────────────────────────────────────────
//
// The subject page used to look its assessments up by two fixed slugs,
// "mid-unit" and "endline", with no subject predicate. quizzes.slug is unique
// programme-wide and quizzes_one_scope binds every quiz to exactly one RTT
// subject, so one "mid-unit" quiz was served on every subject of every phase
// -- results and attempt caps included -- and any quiz under another slug was
// listed nowhere a learner could reach. A subject's assessments are the active
// quizzes bound to it; the slug is only the address.
//
// Takes the database as a parameter (the lib/visibility.ts shape) so the
// behaviour suite can run it on one snapshot.

import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { quizSubmissions, quizzes, rttSubjects } from "@gml/db/schema";
import type { Actor } from "@/lib/visibility";
import { rttScope } from "./scope";

type Db = NodePgDatabase<Record<string, unknown>>;

export type SubjectAssessment = {
  id: string;
  slug: string;
  title: string;
  passThreshold: number;
  maxAttempts: number | null;
  /** This learner's completed submissions. */
  attempts: number;
  bestScore: number | null;
  passed: boolean;
  /** No attempts left under the quiz's cap. */
  spent: boolean;
  /** The runner, or -- once the cap is spent -- the learner's own results. */
  href: string;
};

/** Active quizzes bound to one RTT subject, each with `userId`'s own record. */
export async function listSubjectAssessments(
  db: Db,
  rttSubjectId: string,
  userId: string,
): Promise<SubjectAssessment[]> {
  const mine = db
    .select({
      quizId: quizSubmissions.quizId,
      attempts: sql<number>`count(*)::int`.as("attempts"),
      bestScore: sql<number>`max(${quizSubmissions.score})::int`.as("best_score"),
      passed: sql<boolean>`bool_or(${quizSubmissions.passed})`.as("passed"),
    })
    .from(quizSubmissions)
    .where(eq(quizSubmissions.userId, userId))
    .groupBy(quizSubmissions.quizId)
    .as("mine");
  const rows = await db
    .select({
      id: quizzes.id,
      slug: quizzes.slug,
      title: quizzes.title,
      passThreshold: quizzes.passThreshold,
      maxAttempts: quizzes.maxAttempts,
      attempts: mine.attempts,
      bestScore: mine.bestScore,
      passed: mine.passed,
    })
    .from(quizzes)
    .leftJoin(mine, eq(mine.quizId, quizzes.id))
    .where(and(eq(quizzes.rttSubjectId, rttSubjectId), eq(quizzes.active, true)))
    .orderBy(asc(quizzes.createdAt), asc(quizzes.title));
  return rows.map((r) => {
    const attempts = r.attempts ?? 0;
    // Counted as the runner counts its cap: completed submissions only.
    const spent = r.maxAttempts !== null && attempts >= r.maxAttempts;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      passThreshold: r.passThreshold,
      maxAttempts: r.maxAttempts,
      attempts,
      bestScore: r.bestScore ?? null,
      passed: r.passed ?? false,
      spent,
      href: spent ? `/quizzes/${r.slug}/history` : `/quizzes/${r.slug}`,
    };
  });
}

export type OpenAssessment = { id: string; slug: string; title: string; subjectId: string; subjectName: string };

/**
 * Active RTT quizzes `actor` has not yet submitted, on the subjects she is
 * shown (lib/rtt/scope.ts: a retired subject's quiz is not open). The
 * dashboard counts exactly these and links to /rtt, which lists them, so the
 * to-do's number is the list it leads to. A quiz bound to a curriculum
 * subject (subject_id) is not here: no learner page offers one.
 */
async function openWhere(db: Db, actor: Actor) {
  const scope = await rttScope(db, actor);
  return and(
    scope.subjectWhere,
    eq(quizzes.active, true),
    isNotNull(quizzes.rttSubjectId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${quizSubmissions}
       WHERE ${quizSubmissions.quizId} = ${quizzes.id} AND ${quizSubmissions.userId} = ${actor.id}
    )`,
  );
}

export async function listOpenAssessments(db: Db, actor: Actor): Promise<OpenAssessment[]> {
  const rows = await db
    .select({
      id: quizzes.id,
      slug: quizzes.slug,
      title: quizzes.title,
      subjectId: rttSubjects.id,
      subjectName: rttSubjects.name,
    })
    .from(quizzes)
    .innerJoin(rttSubjects, eq(rttSubjects.id, quizzes.rttSubjectId))
    .where(await openWhere(db, actor))
    .orderBy(asc(rttSubjects.name), asc(quizzes.createdAt), asc(quizzes.title));
  return rows;
}

export async function countOpenAssessments(db: Db, actor: Actor): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(quizzes)
    .innerJoin(rttSubjects, eq(rttSubjects.id, quizzes.rttSubjectId))
    .where(await openWhere(db, actor));
  return row?.c ?? 0;
}
