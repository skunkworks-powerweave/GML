/**
 * Escape a user-supplied string for use inside an ILIKE pattern.
 *
 * `%`, `_` and `\` are wildcards and the escape character in a LIKE pattern, so
 * interpolating raw user input makes the search behave in ways the user never
 * asked for: `%` on its own matches every row, `_` matches any single
 * character, and a trailing `\` can make the pattern invalid.
 *
 * ONE COPY, shared. This function was duplicated verbatim in eight /repo list
 * pages, and the one surface that most needed it -- /api/quickfind, which runs
 * eight leading-wildcard searches across the staff and school roster on every
 * keystroke -- did not have it at all. That is the shape this kind of
 * duplication always fails in: the copies stay correct and the place that was
 * never given a copy is the exception nobody notices.
 *
 * Order matters: backslashes must be doubled FIRST, or the escapes introduced
 * for % and _ would themselves be escaped.
 */
export function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
