// Small, pure formatting helpers shared by the grading pages (server) and the
// grading editors (browser). No words here: only numbers and punctuation.

/** [41, 42, 43, 60] -> "41–43, 60": the percentages a scale misses or doubles. */
export function formatRanges(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

/** A percentage for display: whole numbers without a decimal, else one decimal. */
export function formatPct(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}
