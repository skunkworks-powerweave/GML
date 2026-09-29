import "server-only";

// Loading grading scales. A quiz, an assessment or a rubric may name its own
// scale; otherwise the default scale for what it grades is used, and with no
// default there is no grade (only the score). See ./bands.ts for the maths.

import { and, asc, eq } from "drizzle-orm";
import { gradingBands, gradingScales, type GradingTarget } from "@gml/db/schema";
import type { Db } from "@/lib/visibility";
import type { Band } from "./bands";

export type ScaleWithBands = { id: string; name: string; appliesTo: GradingTarget; bands: Band[] };

async function load(db: Db, scaleId: string): Promise<ScaleWithBands | null> {
  const [scale] = await db
    .select({ id: gradingScales.id, name: gradingScales.name, appliesTo: gradingScales.appliesTo, active: gradingScales.active })
    .from(gradingScales)
    .where(eq(gradingScales.id, scaleId))
    .limit(1);
  if (!scale) return null;
  const bands = await db
    .select({
      label: gradingBands.label,
      minPct: gradingBands.minPct,
      maxPct: gradingBands.maxPct,
      isPass: gradingBands.isPass,
      sequence: gradingBands.sequence,
      description: gradingBands.description,
    })
    .from(gradingBands)
    .where(eq(gradingBands.scaleId, scaleId))
    .orderBy(asc(gradingBands.sequence), asc(gradingBands.minPct));
  return { id: scale.id, name: scale.name, appliesTo: scale.appliesTo, bands };
}

/** The scale to grade with: the one named, or the active default for `target`, or null. */
export async function resolveScale(db: Db, target: GradingTarget, scaleId?: string | null): Promise<ScaleWithBands | null> {
  if (scaleId) {
    const named = await load(db, scaleId);
    if (named) return named;
  }
  const [def] = await db
    .select({ id: gradingScales.id })
    .from(gradingScales)
    .where(and(eq(gradingScales.appliesTo, target), eq(gradingScales.isDefault, true), eq(gradingScales.active, true)))
    .limit(1);
  return def ? load(db, def.id) : null;
}
