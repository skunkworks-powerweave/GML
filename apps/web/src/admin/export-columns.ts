import { getTableColumns } from "drizzle-orm";
import type { AdminEntity } from "./types";

/**
 * The column keys a CSV export writes, in order: the row's `id` first, then the
 * entity's display columns.
 *
 * WHY THE ID. Child tables reference their parent by UUID -- classes.schoolId,
 * sessions.classId, learners.classId -- and CSV import does not resolve a code
 * or a name to an id. So loading a term of data from spreadsheets means: import
 * the parents, EXPORT them to get the generated ids, paste that column into the
 * child sheet, import the child. The export used displayColumns alone, and no
 * entity lists `id` there, so that second step had nothing to copy and the
 * procedure could not be carried out.
 *
 * Importing an export back is unaffected: `id` is not a form field, and the
 * form schemas are plain z.object()s, which strip keys they do not declare.
 *
 * Pure (no database, no server-only) so tests/behaviour can call it directly.
 */
export function exportColumnKeys(entity: AdminEntity): string[] {
  const display = entity.displayColumns.map((c) => c.key);
  const hasId = "id" in (getTableColumns(entity.table) as Record<string, unknown>);
  return hasId ? ["id", ...display.filter((k) => k !== "id")] : display;
}
