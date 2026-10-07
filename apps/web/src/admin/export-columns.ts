import { getTableColumns } from "drizzle-orm";
import type { AdminEntity } from "./types";

/**
 * The column keys a CSV export writes, in order: the row's `id` first, then the
 * entity's display columns, then every form field the grid does not already
 * show.
 *
 * WHY THE ID. Child tables reference their parent by UUID -- classes.schoolId,
 * sessions.classId, learners.classId -- and CSV import does not resolve a code
 * or a name to an id. So loading a term of data from spreadsheets means: import
 * the parents, EXPORT them to get the generated ids, paste that column into the
 * child sheet, import the child. The export used displayColumns alone, and no
 * entity lists `id` there, so that second step had nothing to copy and the
 * procedure could not be carried out.
 *
 * WHY THE FORM FIELDS. An export is meant to be edited and imported again, and
 * the import reads the form's fields. displayColumns are what the grid has room
 * for, not what the form holds: the schools export had no `address`, a
 * mentor's no bio or expertise, a classroom session's no time, duration or
 * notes. So the columns an administrator could fill in a spreadsheet were not in
 * the spreadsheet the product gave them. Those follow the display columns, so
 * the layout operators already script against keeps its place.
 *
 * ONE DELIBERATE EXCLUSION. An entity nothing may import into (mutateRoles is
 * empty: the approvals history and the account requests, which are decided at
 * /approvals) has no round trip to serve, and its form-only columns hold an
 * applicant's free-text message and a submitter's note that its grid never
 * showed. Its export stays what its grid shows.
 *
 * Importing an export back is unaffected: `id` is not a form field, and the
 * form schemas are plain z.object()s, which strip keys they do not declare.
 *
 * Pure (no database, no server-only) so tests/behaviour can call it directly.
 */
export function exportColumnKeys(entity: AdminEntity): string[] {
  const display = entity.displayColumns.map((c) => c.key);
  const acceptsImport = (entity.mutateRoles ?? entity.readRoles).length > 0;
  const keys = acceptsImport ? [...display, ...entity.formFields.filter((f) => !display.includes(f))] : display;
  const hasId = "id" in (getTableColumns(entity.table) as Record<string, unknown>);
  return hasId ? ["id", ...keys.filter((k) => k !== "id")] : keys;
}
