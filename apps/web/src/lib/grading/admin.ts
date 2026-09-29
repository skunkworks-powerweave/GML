import "server-only";

// Writing grading scales and observation rubrics: what /admin/grading does.
//
//   scales    create, rename, replace the bands, make one the default for what
//             it grades (one default per kind, swapped in a transaction),
//             switch on and off, delete (refused while anything names it)
//   rubrics   create, rename, edit the criteria in place, make one the default
//             (one in all), switch on and off, delete (refused while an
//             observation has been scored against its criteria)
//
// Every function takes the database handle and the acting user, checks the
// role itself (a programme admin or super admin), and audits what it changed.
// The pages and server actions (app/(authenticated)/admin/grading) only parse
// the form and show the outcome. The maths is ./bands.ts; loading a scale to
// grade with is ./scales.ts.

import { and, asc, count, eq, inArray, max, ne, sql } from "drizzle-orm";
import {
  assessments,
  gradingBands,
  gradingScales,
  GRADING_TARGETS,
  observationRubrics,
  observationScores,
  quizzes,
  rubricCriteria,
  type GradingTarget,
} from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import type { Actor, Db } from "@/lib/visibility";
import { scaleProblems, type Band } from "./bands";

export const GRADING_ADMIN_ROLES = ["programme_admin", "super_admin"] as const;

export type GradingError =
  | "not_allowed"
  | "not_found"
  | "name_required"
  | "name_taken"
  | "bad_target"
  | "no_bands"
  | "band_label"
  | "band_range"
  | "band_duplicate"
  | "inactive_default"
  | "scale_in_use"
  | "wrong_scale_kind"
  | "no_criteria"
  | "criterion_title"
  | "criterion_max"
  | "criterion_scored"
  | "criterion_below_scores"
  | "rubric_scored"
  | "busy";

export type GradingResult<T = { id: string }> =
  | ({ ok: true } & T)
  | { ok: false; error: GradingError; detail?: Record<string, string | number> };

const fail = (error: GradingError, detail?: Record<string, string | number>) => ({ ok: false as const, error, detail });

const mayAdminister = (actor: Actor) => hasAnyRole(actor.role, GRADING_ADMIN_ROLES);

/** A unique-index violation, as node-postgres reports it (directly or wrapped by drizzle). */
function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  if (e?.code === "23505") return e.constraint ?? "";
  if (e?.cause?.code === "23505") return e.cause.constraint ?? "";
  return null;
}

export const isGradingTarget = (v: unknown): v is GradingTarget =>
  typeof v === "string" && (GRADING_TARGETS as readonly string[]).includes(v);

// ── Scales ───────────────────────────────────────────────────────────────────

export type ScaleSummary = {
  id: string;
  name: string;
  appliesTo: GradingTarget;
  description: string | null;
  isDefault: boolean;
  active: boolean;
  bandCount: number;
};

/** Every scale, by what it grades, the default first, then by name. */
export async function listScales(db: Db): Promise<ScaleSummary[]> {
  // Qualified by hand: in a select from one table drizzle writes ${gradingScales.id}
  // as a bare "id", which inside the subquery is the band's own id.
  const bandCount = sql<number>`(select count(*)::int from grading_bands b where b.scale_id = "grading_scales"."id")`;
  return db
    .select({
      id: gradingScales.id,
      name: gradingScales.name,
      appliesTo: gradingScales.appliesTo,
      description: gradingScales.description,
      isDefault: gradingScales.isDefault,
      active: gradingScales.active,
      bandCount,
    })
    .from(gradingScales)
    .orderBy(asc(gradingScales.appliesTo), sql`${gradingScales.isDefault} desc`, asc(gradingScales.name));
}

export type ScaleDetail = ScaleSummary & { bands: Band[]; updatedAt: Date };

export async function scaleDetail(db: Db, id: string): Promise<ScaleDetail | null> {
  const [s] = await db.select().from(gradingScales).where(eq(gradingScales.id, id)).limit(1);
  if (!s) return null;
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
    .where(eq(gradingBands.scaleId, id))
    .orderBy(asc(gradingBands.sequence), sql`${gradingBands.minPct} desc`);
  return {
    id: s.id,
    name: s.name,
    appliesTo: s.appliesTo,
    description: s.description,
    isDefault: s.isDefault,
    active: s.active,
    bandCount: bands.length,
    bands,
    updatedAt: s.updatedAt,
  };
}

/** What names this scale: a scale in use is not deleted (switch it off instead). */
export async function scaleUsage(db: Db, id: string): Promise<{ assessments: number; quizzes: number; rubrics: number }> {
  const [[a], [q], [r]] = await Promise.all([
    db.select({ n: count() }).from(assessments).where(eq(assessments.gradingScaleId, id)),
    db.select({ n: count() }).from(quizzes).where(eq(quizzes.gradingScaleId, id)),
    db.select({ n: count() }).from(observationRubrics).where(eq(observationRubrics.gradingScaleId, id)),
  ]);
  return { assessments: a?.n ?? 0, quizzes: q?.n ?? 0, rubrics: r?.n ?? 0 };
}

const cleanName = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ");
const cleanText = (s: string | null | undefined) => {
  const v = (s ?? "").trim();
  return v.length ? v : null;
};

/** Create a scale (no id) or rename it / change its description. What it grades is fixed once made. */
export async function saveScale(
  db: Db,
  actor: Actor,
  input: { id?: string | null; name: string; appliesTo?: string | null; description?: string | null },
): Promise<GradingResult> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const name = cleanName(input.name);
  if (!name || name.length > 120) return fail("name_required");
  const description = cleanText(input.description);
  try {
    if (!input.id) {
      if (!isGradingTarget(input.appliesTo)) return fail("bad_target");
      const [row] = await db
        .insert(gradingScales)
        .values({ name, appliesTo: input.appliesTo, description })
        .returning({ id: gradingScales.id });
      await recordAudit({
        action: "grading.scale.saved",
        entityType: "grading_scale",
        entityId: row!.id,
        userId: actor.id,
        metadata: { change: "created", appliesTo: input.appliesTo },
      });
      return { ok: true, id: row!.id };
    }
    const [row] = await db
      .update(gradingScales)
      .set({ name, description, updatedAt: new Date() })
      .where(eq(gradingScales.id, input.id))
      .returning({ id: gradingScales.id, appliesTo: gradingScales.appliesTo });
    if (!row) return fail("not_found");
    await recordAudit({
      action: "grading.scale.saved",
      entityType: "grading_scale",
      entityId: row.id,
      userId: actor.id,
      metadata: { change: "details", appliesTo: row.appliesTo },
    });
    return { ok: true, id: row.id };
  } catch (err) {
    if (uniqueViolation(err) !== null) return fail("name_taken");
    throw err;
  }
}

export type BandInput = { label: string; minPct: number; maxPct: number; isPass: boolean; description?: string | null };

/**
 * Check a scale's bands. Hard errors (refused): an empty or over-long label, a
 * range outside 0..100 or backwards, two bands with one label, no bands.
 * Gaps and overlaps are warnings (./bands.ts scaleProblems): saved, and shown.
 */
export function validateBands(bands: readonly BandInput[]): GradingResult<{ bands: Band[] }> {
  if (bands.length === 0) return fail("no_bands");
  const seen = new Set<string>();
  const out: Band[] = [];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]!;
    const row = i + 1;
    const label = (b.label ?? "").trim();
    if (!label || label.length > 32) return fail("band_label", { row });
    const { minPct, maxPct } = b;
    if (
      !Number.isInteger(minPct) ||
      !Number.isInteger(maxPct) ||
      minPct < 0 ||
      maxPct > 100 ||
      minPct > maxPct
    ) {
      return fail("band_range", { row, label });
    }
    const key = label.toLowerCase();
    if (seen.has(key)) return fail("band_duplicate", { row, label });
    seen.add(key);
    const description = cleanText(b.description)?.slice(0, 200) ?? null;
    out.push({ label, minPct, maxPct, isPass: Boolean(b.isPass), sequence: row, description });
  }
  return { ok: true, bands: out };
}

/** Replace a scale's bands with these, in the order given. */
export async function saveBands(
  db: Db,
  actor: Actor,
  scaleId: string,
  input: readonly BandInput[],
): Promise<GradingResult<{ id: string; gaps: number[]; overlaps: number[] }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const checked = validateBands(input);
  if (!checked.ok) return checked;
  const bands = checked.bands;
  const appliesTo = await db.transaction(async (tx) => {
    const [scale] = await tx
      .select({ id: gradingScales.id, appliesTo: gradingScales.appliesTo })
      .from(gradingScales)
      .where(eq(gradingScales.id, scaleId))
      .for("update");
    if (!scale) return null;
    await tx.delete(gradingBands).where(eq(gradingBands.scaleId, scaleId));
    await tx.insert(gradingBands).values(
      bands.map((b) => ({
        scaleId,
        label: b.label,
        minPct: b.minPct,
        maxPct: b.maxPct,
        isPass: b.isPass,
        sequence: b.sequence,
        description: b.description ?? null,
      })),
    );
    await tx.update(gradingScales).set({ updatedAt: new Date() }).where(eq(gradingScales.id, scaleId));
    return scale.appliesTo;
  });
  if (!appliesTo) return fail("not_found");
  const { gaps, overlaps } = scaleProblems(bands);
  await recordAudit({
    action: "grading.scale.saved",
    entityType: "grading_scale",
    entityId: scaleId,
    userId: actor.id,
    metadata: { change: "bands", appliesTo, bands: bands.length, gaps: gaps.length, overlaps: overlaps.length },
  });
  return { ok: true, id: scaleId, gaps, overlaps };
}

/**
 * Make this scale the default for what it grades. The previous default (if
 * any) stops being one in the same transaction, so there is never a moment
 * with two -- the database's one-default index would refuse it anyway.
 */
export async function setDefaultScale(db: Db, actor: Actor, scaleId: string): Promise<GradingResult<{ id: string; previousId: string | null }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  let outcome: GradingResult<{ id: string; previousId: string | null; appliesTo: GradingTarget }>;
  try {
    outcome = await db.transaction(async (tx) => {
      const [scale] = await tx
        .select({ id: gradingScales.id, appliesTo: gradingScales.appliesTo, active: gradingScales.active, isDefault: gradingScales.isDefault })
        .from(gradingScales)
        .where(eq(gradingScales.id, scaleId))
        .for("update");
      if (!scale) return fail("not_found");
      if (!scale.active) return fail("inactive_default");
      const [previous] = await tx
        .update(gradingScales)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(gradingScales.appliesTo, scale.appliesTo), eq(gradingScales.isDefault, true), ne(gradingScales.id, scaleId)))
        .returning({ id: gradingScales.id });
      await tx.update(gradingScales).set({ isDefault: true, updatedAt: new Date() }).where(eq(gradingScales.id, scaleId));
      return { ok: true as const, id: scaleId, previousId: previous?.id ?? null, appliesTo: scale.appliesTo };
    });
  } catch (err) {
    // Another administrator made a different scale the default at the same moment.
    if (uniqueViolation(err) !== null) return fail("busy");
    throw err;
  }
  if (!outcome.ok) return outcome;
  await recordAudit({
    action: "grading.scale.default_set",
    entityType: "grading_scale",
    entityId: scaleId,
    userId: actor.id,
    metadata: { appliesTo: outcome.appliesTo, previousId: outcome.previousId },
  });
  return { ok: true, id: scaleId, previousId: outcome.previousId };
}

/** Switch a scale on or off. Switching the default off leaves its kind with no default. */
export async function setScaleActive(db: Db, actor: Actor, scaleId: string, active: boolean): Promise<GradingResult<{ id: string; defaultCleared: boolean }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const [before] = await db
    .select({ isDefault: gradingScales.isDefault, appliesTo: gradingScales.appliesTo })
    .from(gradingScales)
    .where(eq(gradingScales.id, scaleId))
    .limit(1);
  if (!before) return fail("not_found");
  const defaultCleared = !active && before.isDefault;
  await db
    .update(gradingScales)
    .set({ active, ...(defaultCleared ? { isDefault: false } : {}), updatedAt: new Date() })
    .where(eq(gradingScales.id, scaleId));
  await recordAudit({
    action: "grading.scale.saved",
    entityType: "grading_scale",
    entityId: scaleId,
    userId: actor.id,
    metadata: { change: active ? "activated" : "deactivated", appliesTo: before.appliesTo, defaultCleared },
  });
  return { ok: true, id: scaleId, defaultCleared };
}

/**
 * Delete a scale and its bands. Refused while an assessment, a quiz or a
 * rubric names it: their grades would silently move to the default scale.
 */
export async function deleteScale(db: Db, actor: Actor, scaleId: string): Promise<GradingResult> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const [scale] = await db
    .select({ name: gradingScales.name, appliesTo: gradingScales.appliesTo })
    .from(gradingScales)
    .where(eq(gradingScales.id, scaleId))
    .limit(1);
  if (!scale) return fail("not_found");
  const usage = await scaleUsage(db, scaleId);
  if (usage.assessments + usage.quizzes + usage.rubrics > 0) return fail("scale_in_use", usage);
  await db.delete(gradingScales).where(eq(gradingScales.id, scaleId));
  await recordAudit({
    action: "grading.scale.deleted",
    entityType: "grading_scale",
    entityId: scaleId,
    userId: actor.id,
    metadata: { name: scale.name, appliesTo: scale.appliesTo },
  });
  return { ok: true, id: scaleId };
}

// ── Rubrics ──────────────────────────────────────────────────────────────────

export type RubricSummary = {
  id: string;
  name: string;
  description: string | null;
  gradingScaleId: string | null;
  scaleName: string | null;
  isDefault: boolean;
  active: boolean;
  criterionCount: number;
  maxTotal: number;
};

export async function listRubrics(db: Db): Promise<RubricSummary[]> {
  const rows = await db
    .select({
      id: observationRubrics.id,
      name: observationRubrics.name,
      description: observationRubrics.description,
      gradingScaleId: observationRubrics.gradingScaleId,
      scaleName: gradingScales.name,
      isDefault: observationRubrics.isDefault,
      active: observationRubrics.active,
      criterionCount: sql<number>`(select count(*)::int from rubric_criteria c where c.rubric_id = ${observationRubrics.id})`,
      maxTotal: sql<number>`(select coalesce(sum(c.max_score), 0)::int from rubric_criteria c where c.rubric_id = ${observationRubrics.id})`,
    })
    .from(observationRubrics)
    .leftJoin(gradingScales, eq(gradingScales.id, observationRubrics.gradingScaleId))
    .orderBy(sql`${observationRubrics.isDefault} desc`, asc(observationRubrics.name));
  return rows;
}

export type CriterionRow = { id: string; sequence: number; title: string; description: string | null; maxScore: number; scored: number };

export async function rubricDetail(db: Db, id: string): Promise<(RubricSummary & { criteria: CriterionRow[]; scoredCycles: number }) | null> {
  const [r] = (await listRubrics(db)).filter((x) => x.id === id);
  if (!r) return null;
  const criteria = await db
    .select({
      id: rubricCriteria.id,
      sequence: rubricCriteria.sequence,
      title: rubricCriteria.title,
      description: rubricCriteria.description,
      maxScore: rubricCriteria.maxScore,
      // Qualified by hand, as in listScales: a bare "id" here is the score's own.
      scored: sql<number>`(select count(*)::int from observation_scores s where s.criterion_id = "rubric_criteria"."id")`,
    })
    .from(rubricCriteria)
    .where(eq(rubricCriteria.rubricId, id))
    .orderBy(asc(rubricCriteria.sequence));
  return { ...r, criteria, scoredCycles: await scoredCycles(db, id) };
}

/** How many observation cycles hold scores against this rubric's criteria. */
async function scoredCycles(db: Db, rubricId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${observationScores.cycleId})::int` })
    .from(observationScores)
    .innerJoin(rubricCriteria, eq(rubricCriteria.id, observationScores.criterionId))
    .where(eq(rubricCriteria.rubricId, rubricId));
  return row?.n ?? 0;
}

/** A rubric's scale must grade observations. */
async function checkObservationScale(db: Db, scaleId: string | null): Promise<GradingError | null> {
  if (!scaleId) return null;
  const [s] = await db.select({ appliesTo: gradingScales.appliesTo }).from(gradingScales).where(eq(gradingScales.id, scaleId)).limit(1);
  if (!s) return "not_found";
  return s.appliesTo === "observation" ? null : "wrong_scale_kind";
}

/** Create a rubric (no id), optionally as the default, or change its name, description and scale. */
export async function saveRubric(
  db: Db,
  actor: Actor,
  input: { id?: string | null; name: string; description?: string | null; gradingScaleId?: string | null; makeDefault?: boolean },
): Promise<GradingResult> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const name = cleanName(input.name);
  if (!name || name.length > 160) return fail("name_required");
  const description = cleanText(input.description);
  const gradingScaleId = input.gradingScaleId || null;
  const scaleError = await checkObservationScale(db, gradingScaleId);
  if (scaleError) return fail(scaleError);
  try {
    if (!input.id) {
      const [row] = await db
        .insert(observationRubrics)
        .values({ name, description, gradingScaleId })
        .returning({ id: observationRubrics.id });
      await recordAudit({
        action: "grading.rubric.saved",
        entityType: "observation_rubric",
        entityId: row!.id,
        userId: actor.id,
        metadata: { change: "created", gradingScaleId },
      });
      if (input.makeDefault) {
        const made = await setDefaultRubric(db, actor, row!.id);
        if (!made.ok) return made;
      }
      return { ok: true, id: row!.id };
    }
    const [row] = await db
      .update(observationRubrics)
      .set({ name, description, gradingScaleId, updatedAt: new Date() })
      .where(eq(observationRubrics.id, input.id))
      .returning({ id: observationRubrics.id });
    if (!row) return fail("not_found");
    await recordAudit({
      action: "grading.rubric.saved",
      entityType: "observation_rubric",
      entityId: row.id,
      userId: actor.id,
      metadata: { change: "details", gradingScaleId },
    });
    return { ok: true, id: row.id };
  } catch (err) {
    if (uniqueViolation(err) !== null) return fail("name_taken");
    throw err;
  }
}

export type CriterionInput = { id?: string | null; title: string; description?: string | null; maxScore: number };

/**
 * Save a rubric's criteria, in the order given. Criteria keep their ids, so
 * scores already recorded against one stay attached when it is renamed or
 * moved. A criterion that has been scored cannot be removed, nor its maximum
 * lowered below a score it was given.
 */
export async function saveCriteria(
  db: Db,
  actor: Actor,
  rubricId: string,
  input: readonly CriterionInput[],
): Promise<GradingResult<{ id: string; added: number; removed: number }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  if (input.length === 0) return fail("no_criteria");
  const rows: Array<CriterionInput & { title: string; sequence: number }> = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const row = i + 1;
    const title = cleanName(c.title);
    if (!title || title.length > 200) return fail("criterion_title", { row });
    if (!Number.isInteger(c.maxScore) || c.maxScore < 1 || c.maxScore > 10) return fail("criterion_max", { row, title });
    rows.push({ ...c, id: c.id || null, title, description: cleanText(c.description), sequence: row });
  }

  const result = await db.transaction(async (tx) => {
    const [rubric] = await tx
      .select({ id: observationRubrics.id })
      .from(observationRubrics)
      .where(eq(observationRubrics.id, rubricId))
      .for("update");
    if (!rubric) return fail("not_found");
    const existing = await tx
      .select({ id: rubricCriteria.id, title: rubricCriteria.title })
      .from(rubricCriteria)
      .where(eq(rubricCriteria.rubricId, rubricId));
    const existingIds = new Set(existing.map((e) => e.id));
    for (const r of rows) if (r.id && !existingIds.has(r.id)) return fail("not_found");
    const kept = new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
    const removed = existing.filter((e) => !kept.has(e.id));

    // What has been scored, and the highest score each criterion was given.
    const touched = existing.map((e) => e.id);
    const scored = touched.length
      ? await tx
          .select({ criterionId: observationScores.criterionId, top: max(observationScores.score) })
          .from(observationScores)
          .where(inArray(observationScores.criterionId, touched))
          .groupBy(observationScores.criterionId)
      : [];
    const topScore = new Map(scored.map((s) => [s.criterionId, Number(s.top ?? 0)]));
    const scoredRemoval = removed.find((e) => topScore.has(e.id));
    if (scoredRemoval) return fail("criterion_scored", { title: scoredRemoval.title });
    for (const r of rows) {
      if (r.id && topScore.has(r.id) && r.maxScore < topScore.get(r.id)!) {
        return fail("criterion_below_scores", { row: r.sequence, title: r.title, score: topScore.get(r.id)! });
      }
    }

    if (removed.length) await tx.delete(rubricCriteria).where(inArray(rubricCriteria.id, removed.map((e) => e.id)));
    // Order is unique per rubric: move every kept criterion out of the way
    // first, so reordering never collides with a position still taken.
    if (kept.size) {
      await tx
        .update(rubricCriteria)
        .set({ sequence: sql`-1 - ${rubricCriteria.sequence}` })
        .where(inArray(rubricCriteria.id, [...kept]));
    }
    let added = 0;
    for (const r of rows) {
      const values = { sequence: r.sequence, title: r.title, description: r.description ?? null, maxScore: r.maxScore };
      if (r.id) await tx.update(rubricCriteria).set(values).where(eq(rubricCriteria.id, r.id));
      else {
        await tx.insert(rubricCriteria).values({ rubricId, ...values });
        added++;
      }
    }
    await tx.update(observationRubrics).set({ updatedAt: new Date() }).where(eq(observationRubrics.id, rubricId));
    return { ok: true as const, id: rubricId, added, removed: removed.length };
  });
  if (!result.ok) return result;
  await recordAudit({
    action: "grading.rubric.saved",
    entityType: "observation_rubric",
    entityId: rubricId,
    userId: actor.id,
    metadata: { change: "criteria", criteria: rows.length, added: result.added, removed: result.removed },
  });
  return result;
}

/** Make this rubric the one new observations are scored with. */
export async function setDefaultRubric(db: Db, actor: Actor, rubricId: string): Promise<GradingResult<{ id: string; previousId: string | null }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  let outcome: GradingResult<{ id: string; previousId: string | null }>;
  try {
    outcome = await db.transaction(async (tx) => {
      const [r] = await tx
        .select({ id: observationRubrics.id, active: observationRubrics.active })
        .from(observationRubrics)
        .where(eq(observationRubrics.id, rubricId))
        .for("update");
      if (!r) return fail("not_found");
      if (!r.active) return fail("inactive_default");
      const [previous] = await tx
        .update(observationRubrics)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(observationRubrics.isDefault, true), ne(observationRubrics.id, rubricId)))
        .returning({ id: observationRubrics.id });
      await tx.update(observationRubrics).set({ isDefault: true, updatedAt: new Date() }).where(eq(observationRubrics.id, rubricId));
      return { ok: true as const, id: rubricId, previousId: previous?.id ?? null };
    });
  } catch (err) {
    if (uniqueViolation(err) !== null) return fail("busy");
    throw err;
  }
  if (!outcome.ok) return outcome;
  await recordAudit({
    action: "grading.rubric.default_set",
    entityType: "observation_rubric",
    entityId: rubricId,
    userId: actor.id,
    metadata: { previousId: outcome.previousId },
  });
  return outcome;
}

export async function setRubricActive(db: Db, actor: Actor, rubricId: string, active: boolean): Promise<GradingResult<{ id: string; defaultCleared: boolean }>> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const [before] = await db
    .select({ isDefault: observationRubrics.isDefault })
    .from(observationRubrics)
    .where(eq(observationRubrics.id, rubricId))
    .limit(1);
  if (!before) return fail("not_found");
  const defaultCleared = !active && before.isDefault;
  await db
    .update(observationRubrics)
    .set({ active, ...(defaultCleared ? { isDefault: false } : {}), updatedAt: new Date() })
    .where(eq(observationRubrics.id, rubricId));
  await recordAudit({
    action: "grading.rubric.saved",
    entityType: "observation_rubric",
    entityId: rubricId,
    userId: actor.id,
    metadata: { change: active ? "activated" : "deactivated", defaultCleared },
  });
  return { ok: true, id: rubricId, defaultCleared };
}

/**
 * Delete a rubric and its criteria. Refused while any observation has been
 * scored against it: those scores are the observation's record.
 */
export async function deleteRubric(db: Db, actor: Actor, rubricId: string): Promise<GradingResult> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  const [r] = await db
    .select({ name: observationRubrics.name })
    .from(observationRubrics)
    .where(eq(observationRubrics.id, rubricId))
    .limit(1);
  if (!r) return fail("not_found");
  const cycles = await scoredCycles(db, rubricId);
  if (cycles > 0) return fail("rubric_scored", { cycles });
  const [{ n: criteria } = { n: 0 }] = await db.select({ n: count() }).from(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId));
  try {
    await db.delete(observationRubrics).where(eq(observationRubrics.id, rubricId));
  } catch (err) {
    // A score recorded between the check and the delete: the criteria's
    // RESTRICT foreign key refuses, and so do we.
    const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23503") return fail("rubric_scored", { cycles: 1 });
    throw err;
  }
  await recordAudit({
    action: "grading.rubric.deleted",
    entityType: "observation_rubric",
    entityId: rubricId,
    userId: actor.id,
    metadata: { name: r.name, criteria },
  });
  return { ok: true, id: rubricId };
}

// ── Quizzes ──────────────────────────────────────────────────────────────────

/** Name the scale a quiz's results are graded with (null: the default quiz scale). */
export async function setQuizScale(db: Db, actor: Actor, quizId: string, scaleId: string | null): Promise<GradingResult> {
  if (!mayAdminister(actor)) return fail("not_allowed");
  if (scaleId) {
    const [s] = await db.select({ appliesTo: gradingScales.appliesTo }).from(gradingScales).where(eq(gradingScales.id, scaleId)).limit(1);
    if (!s) return fail("not_found");
    if (s.appliesTo !== "quiz") return fail("wrong_scale_kind");
  }
  const [row] = await db
    .update(quizzes)
    .set({ gradingScaleId: scaleId, updatedAt: new Date() })
    .where(eq(quizzes.id, quizId))
    .returning({ id: quizzes.id });
  if (!row) return fail("not_found");
  await recordAudit({
    action: "grading.quiz.scale_set",
    entityType: "quiz",
    entityId: quizId,
    userId: actor.id,
    metadata: { scaleId },
  });
  return { ok: true, id: quizId };
}

/** Scales of one kind, for a select: active ones, the default first. */
export async function scaleOptions(db: Db, target: GradingTarget): Promise<Array<{ id: string; name: string; isDefault: boolean }>> {
  return db
    .select({ id: gradingScales.id, name: gradingScales.name, isDefault: gradingScales.isDefault })
    .from(gradingScales)
    .where(and(eq(gradingScales.appliesTo, target), eq(gradingScales.active, true)))
    .orderBy(sql`${gradingScales.isDefault} desc`, asc(gradingScales.name));
}
