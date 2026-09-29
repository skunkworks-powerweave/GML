import "server-only";

// A quiz result's grade: the band its score falls in on the quiz's own scale
// (quizzes.grading_scale_id) or, when it names none, the default quiz scale.
// Pass or fail still comes from the quiz's pass mark; the grade sits beside
// it. No scale at all: no grade, only the score.

import type { Db } from "@/lib/visibility";
import { bandFor, type Band } from "./bands";
import { resolveScale, type ScaleWithBands } from "./scales";

export type QuizGrader = { scale: ScaleWithBands | null; bandOf: (scorePct: number | null | undefined) => Band | null };

/** Load the scale once, then grade any number of attempts of the quiz. */
export async function quizGrader(db: Db, quiz: { gradingScaleId: string | null }): Promise<QuizGrader> {
  const scale = await resolveScale(db, "quiz", quiz.gradingScaleId);
  return {
    scale,
    bandOf: (score) => (scale && score != null ? bandFor(score, scale.bands) : null),
  };
}
