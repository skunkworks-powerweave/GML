// The scored rubric on an observation cycle: which rubric applies, what the
// observer posted for it, and the total, percentage and band everyone on the
// cycle reads.
//
//   rubricFor         the cycle's own rubric (observation_cycles.rubric_id,
//                     set when the observer first scores), else the active
//                     default rubric; null when neither has any criteria, in
//                     which case the observer form is the narrative alone, as
//                     it was before scored rubrics existed
//   parseRubricScores the observer's scores, checked on the SERVER: one whole
//                     number 0..max_score per criterion, an optional note
//   writeScores       the scores, inside the caller's transaction, and the
//                     cycle's rubric_id with them
//   cycleScoreSummary per criterion, total / maximum, percentage and band
//                     (lib/grading: the rubric's scale, else the default
//                     observation scale)
//
// Database as a parameter, as in lib/visibility.ts, so tests/behaviour can run
// it on a transaction it rolls back.

import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { observationCycles, observationRubrics, observationScores, rubricCriteria, users } from "@gml/db/schema";
import { bandFor, percentOf, type Band } from "../grading/bands";
import { resolveScale } from "../grading/scales";
import { MAX_TEXT_LENGTH, normaliseLineBreaks } from "../forms/validate";
import type { Db } from "../visibility";

export type RubricCriterionView = {
  id: string;
  sequence: number;
  title: string;
  description: string | null;
  maxScore: number;
};

export type CycleRubric = {
  id: string;
  name: string;
  description: string | null;
  gradingScaleId: string | null;
  criteria: RubricCriterionView[];
};

/** A transaction handle, or the database itself. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The rubric to score a cycle with: the one it names, else the active default.
 * A rubric with no criteria scores nothing, so it counts as none.
 */
export async function rubricFor(db: Db, rubricId: string | null | undefined): Promise<CycleRubric | null> {
  const [rubric] = await db
    .select({
      id: observationRubrics.id,
      name: observationRubrics.name,
      description: observationRubrics.description,
      gradingScaleId: observationRubrics.gradingScaleId,
    })
    .from(observationRubrics)
    .where(
      rubricId
        ? eq(observationRubrics.id, rubricId)
        : and(eq(observationRubrics.isDefault, true), eq(observationRubrics.active, true)),
    )
    .limit(1);
  if (!rubric) return null;
  const criteria = await db
    .select({
      id: rubricCriteria.id,
      sequence: rubricCriteria.sequence,
      title: rubricCriteria.title,
      description: rubricCriteria.description,
      maxScore: rubricCriteria.maxScore,
    })
    .from(rubricCriteria)
    .where(eq(rubricCriteria.rubricId, rubric.id))
    .orderBy(asc(rubricCriteria.sequence));
  if (criteria.length === 0) return null;
  return { ...rubric, criteria };
}

/** The form field a criterion's score is posted in. */
export const scoreField = (criterionId: string) => `score_${criterionId}`;
/** The form field a criterion's note is posted in. */
export const noteField = (criterionId: string) => `scoreNote_${criterionId}`;

export type ScoreInput = { criterionId: string; score: number; note: string | null };

export type ScoreParse = { ok: true; scores: ScoreInput[] } | { ok: false; criterionId: string };

/**
 * Every criterion's score, from the posted form. A score is a whole number
 * from 0 to the criterion's maximum and every criterion needs one: a total
 * over half the rubric would read as a low grade. The note is optional,
 * trimmed, and capped as every other answer on the cycle is. Only this
 * rubric's criteria are read. The first criterion that fails is named.
 */
export function parseRubricScores(rubric: CycleRubric, formData: FormData): ScoreParse {
  const scores: ScoreInput[] = [];
  for (const c of rubric.criteria) {
    const raw = formData.get(scoreField(c.id));
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!/^\d{1,2}$/.test(text)) return { ok: false, criterionId: c.id };
    const score = Number(text);
    if (score < 0 || score > c.maxScore) return { ok: false, criterionId: c.id };
    const rawNote = formData.get(noteField(c.id));
    const note = typeof rawNote === "string" ? normaliseLineBreaks(rawNote).trim() : "";
    if (note.length > MAX_TEXT_LENGTH) return { ok: false, criterionId: c.id };
    scores.push({ criterionId: c.id, score, note: note || null });
  }
  return { ok: true, scores };
}

/**
 * Save a cycle's scores and record which rubric they belong to. Inside the
 * caller's transaction, after its guarded status check. A revision replaces
 * each criterion's score (the latest wins, with its scorer and time); a score
 * for a criterion this rubric no longer has would skew the total, so it goes.
 */
export async function writeScores(
  tx: DbOrTx,
  input: { cycleId: string; rubricId: string; scores: ScoreInput[]; userId: string },
): Promise<void> {
  if (input.scores.length === 0) return;
  const now = new Date();
  await tx
    .insert(observationScores)
    .values(
      input.scores.map((s) => ({
        cycleId: input.cycleId,
        criterionId: s.criterionId,
        score: s.score,
        note: s.note,
        scoredByUserId: input.userId,
        scoredAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [observationScores.cycleId, observationScores.criterionId],
      set: {
        score: sql`excluded.score`,
        note: sql`excluded.note`,
        scoredByUserId: sql`excluded.scored_by_user_id`,
        scoredAt: sql`excluded.scored_at`,
      },
    });
  await tx
    .delete(observationScores)
    .where(
      and(
        eq(observationScores.cycleId, input.cycleId),
        notInArray(
          observationScores.criterionId,
          input.scores.map((s) => s.criterionId),
        ),
      ),
    );
  await tx
    .update(observationCycles)
    .set({ rubricId: input.rubricId })
    .where(eq(observationCycles.id, input.cycleId));
}

/** The sum of the scores and of the maxima, for the audit row. */
export function totals(rubric: CycleRubric, scores: readonly { criterionId: string; score: number }[]) {
  const byId = new Map(scores.map((s) => [s.criterionId, s.score]));
  let total = 0;
  let max = 0;
  for (const c of rubric.criteria) {
    max += c.maxScore;
    total += byId.get(c.id) ?? 0;
  }
  return { total, max };
}

export type ScoredCriterion = RubricCriterionView & { score: number | null; note: string | null };

export type ScoreSummary = {
  rubricName: string;
  criteria: ScoredCriterion[];
  total: number;
  max: number;
  /** Rounded to a whole number, as the band is chosen. */
  pct: number | null;
  band: Band | null;
  /** Whether any grade scale applies at all (else only the score is shown). */
  graded: boolean;
  scoredAt: Date | null;
  scoredBy: string | null;
};

/** Per criterion, the total, percentage and band. Pure. */
export function summarise(
  rubric: CycleRubric,
  scores: readonly { criterionId: string; score: number; note: string | null }[],
  bands: readonly Band[] | null,
): Omit<ScoreSummary, "scoredAt" | "scoredBy"> {
  const byId = new Map(scores.map((s) => [s.criterionId, s]));
  const criteria = rubric.criteria.map((c) => {
    const s = byId.get(c.id);
    return { ...c, score: s?.score ?? null, note: s?.note ?? null };
  });
  const { total, max } = totals(rubric, scores);
  const raw = percentOf(total, max);
  return {
    rubricName: rubric.name,
    criteria,
    total,
    max,
    pct: raw == null ? null : Math.round(raw),
    band: bands ? bandFor(raw, bands) : null,
    graded: bands != null && bands.length > 0,
  };
}

/**
 * What the cycle page shows of the scores, or null when the cycle has none
 * (no rubric was used on it).
 */
export async function cycleScoreSummary(db: Db, cycle: { id: string; rubricId: string | null }): Promise<ScoreSummary | null> {
  if (!cycle.rubricId) return null;
  const rubric = await rubricFor(db, cycle.rubricId);
  if (!rubric) return null;
  const rows = await db
    .select({
      criterionId: observationScores.criterionId,
      score: observationScores.score,
      note: observationScores.note,
      scoredAt: observationScores.scoredAt,
      scoredBy: sql<string | null>`coalesce(${users.name}, ${users.email})`,
    })
    .from(observationScores)
    .leftJoin(users, eq(users.id, observationScores.scoredByUserId))
    .where(eq(observationScores.cycleId, cycle.id));
  if (rows.length === 0) return null;
  const scale = await resolveScale(db, "observation", rubric.gradingScaleId);
  const latest = rows.reduce((a, b) => (b.scoredAt > a.scoredAt ? b : a));
  return {
    ...summarise(rubric, rows, scale?.bands ?? null),
    scoredAt: latest.scoredAt,
    scoredBy: latest.scoredBy,
  };
}
