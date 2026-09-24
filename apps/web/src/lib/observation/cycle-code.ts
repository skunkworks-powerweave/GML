// Observation cycle codes: "OBS-<year>-<NNN>", e.g. OBS-2026-009.
//
// The demo seed wrote OBS-2026-001..008 by hand. Nothing else ever minted one,
// because nothing else ever created a cycle. /observation/new now does, and an
// administrator should not have to invent the next free code -- a collision is
// a UNIQUE violation, and a guessed gap is a code that reads as out of order.
//
// Pure (no database, no server-only) so tests/behaviour can call it directly.

const PATTERN = /^OBS-(\d{4})-(\d+)$/;

/** The LIKE prefix that selects every code for `year`. */
export function cycleCodePrefix(year: number): string {
  return `OBS-${year}-`;
}

/**
 * The next free code for `year`, given the codes that already exist.
 *
 * Codes that do not match the pattern, or belong to another year, are ignored
 * -- an administrator may have hand-entered "PILOT-1" in the grid, and that
 * must not break numbering. At least three digits, more once 999 is passed.
 */
export function nextCycleCode(year: number, existing: readonly string[]): string {
  let max = 0;
  for (const code of existing) {
    const m = PATTERN.exec(code.trim());
    if (!m || Number(m[1]) !== year) continue;
    const n = Number(m[2]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return `${cycleCodePrefix(year)}${String(max + 1).padStart(3, "0")}`;
}
