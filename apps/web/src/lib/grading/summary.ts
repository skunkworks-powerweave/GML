// A class's marks, graded: each student's percentage and band, and the class
// average and pass count. Pure -- no database -- so the marks page (server)
// and the marks editor (browser, as the teacher types) grade the same way.
// The maths is ./bands.ts.

import { bandFor, percentOf, type Band } from "./bands";

export type MarkEntry = { marks: number | null; absent: boolean };

export type GradedMark = { pct: number | null; band: Band | null };

/** One student's percentage (rounded to one decimal) and band. Absent or blank: neither. */
export function gradeMark(entry: MarkEntry, maxMarks: number, bands: readonly Band[] | null): GradedMark {
  if (entry.absent || entry.marks == null) return { pct: null, band: null };
  const raw = percentOf(entry.marks, maxMarks);
  if (raw == null) return { pct: null, band: null };
  return { pct: Math.round(raw * 10) / 10, band: bands ? bandFor(raw, bands) : null };
}

export type ClassSummary = {
  /** Students with marks. */
  graded: number;
  absent: number;
  /** On the roster with neither marks nor absent. */
  blank: number;
  /** Mean percentage of the graded students, one decimal; null when nobody is graded. */
  average: number | null;
  /** Graded students whose band counts as a pass; null without a scale. */
  passed: number | null;
  /** The average's band, when there is a scale. */
  averageBand: Band | null;
};

export function summarise(entries: readonly MarkEntry[], maxMarks: number, bands: readonly Band[] | null): ClassSummary {
  let graded = 0;
  let absent = 0;
  let blank = 0;
  let passed = 0;
  let sum = 0;
  for (const e of entries) {
    if (e.absent) {
      absent++;
      continue;
    }
    const g = gradeMark(e, maxMarks, bands);
    if (g.pct == null) {
      blank++;
      continue;
    }
    graded++;
    sum += percentOf(e.marks, maxMarks) ?? 0;
    if (g.band?.isPass) passed++;
  }
  const average = graded ? Math.round((sum / graded) * 10) / 10 : null;
  return {
    graded,
    absent,
    blank,
    average,
    passed: bands ? passed : null,
    averageBand: bands && average != null ? bandFor(average, bands) : null,
  };
}

/**
 * Marks as typed: "" is none, otherwise a number from 0 to the maximum with
 * at most two decimals (the column's precision). Returns undefined when the
 * text is not such a number.
 */
export function parseMarks(raw: string, maxMarks: number): number | null | undefined {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > maxMarks) return undefined;
  return n;
}
