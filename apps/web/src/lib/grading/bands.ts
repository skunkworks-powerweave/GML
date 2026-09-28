// Turning a score into a grade: pure functions, no database.
//
// A scale's bands cover whole percentages, min_pct..max_pct inclusive
// (grading_bands, packages/db/src/schema/grading.ts). A score is first made a
// percentage of its maximum and ROUNDED to the nearest whole number, so 90.5%
// falls in 91-100 and 90.4% in 81-90 -- the way a teacher rounds on a report
// card. Every consumer (a student's marks, a quiz result, an observation
// rubric total) grades through here, so they cannot disagree.

export type Band = {
  label: string;
  minPct: number;
  maxPct: number;
  isPass: boolean;
  sequence: number;
  description?: string | null;
};

/** `score` out of `max` as a percentage (unrounded), or null when there is nothing to grade. */
export function percentOf(score: number | null | undefined, max: number | null | undefined): number | null {
  if (score == null || max == null || !Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return null;
  return (score / max) * 100;
}

/** The band a percentage falls in, or null (no percentage, or a gap in the scale). */
export function bandFor(pct: number | null, bands: readonly Band[]): Band | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const p = Math.min(100, Math.max(0, Math.round(pct)));
  // Highest band first, so a scale whose bands overlap at an edge gives the better grade.
  const ordered = [...bands].sort((a, b) => b.minPct - a.minPct || a.sequence - b.sequence);
  return ordered.find((b) => p >= b.minPct && p <= b.maxPct) ?? null;
}

/**
 * Gaps and overlaps in a scale, for the admin editor: every whole percentage
 * 0..100 should fall in exactly one band.
 */
export function scaleProblems(bands: readonly Band[]): { gaps: number[]; overlaps: number[] } {
  const gaps: number[] = [];
  const overlaps: number[] = [];
  for (let p = 0; p <= 100; p++) {
    const n = bands.filter((b) => p >= b.minPct && p <= b.maxPct).length;
    if (n === 0) gaps.push(p);
    else if (n > 1) overlaps.push(p);
  }
  return { gaps, overlaps };
}
