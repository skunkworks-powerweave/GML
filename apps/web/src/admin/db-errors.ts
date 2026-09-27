// A database refusal, in one sentence an administrator can act on, naming the
// FIELD it is about -- never the driver's own text.
//
// The grid's create and update, and the CSV import, returned
// `Insert failed: ${String(err)}` / `bulk_insert failed: ...`: constraint and
// table names ("duplicate key value violates unique constraint
// \"schools_code_unique\"") on a page programme_admin can reach, and nothing
// that says which column of which row to fix. deleteRowAction already refused
// to show raw driver text; this is the same rule for writes.
//
// Postgres puts the offending column in the error's `detail` ("Key
// (code)=(GPS-CHU) already exists.", "Key (zone_id)=(...) is not present in
// table \"zones\".") or `column`; it is mapped back to the form's field name.
// The sentence is in the viewer's language (adminData.dbError).

import { getTableColumns } from "drizzle-orm";
import type { Translate } from "./labels";
import type { AdminEntity } from "./types";

type PgError = { code?: string; detail?: string; column?: string; constraint?: string };

/** The form field whose SQL column is `sqlName`, or the SQL name if none. */
function fieldFor(entity: AdminEntity, sqlName: string): string {
  const cols = getTableColumns(entity.table) as Record<string, { name?: string }>;
  return Object.entries(cols).find(([, c]) => c.name === sqlName)?.[0] ?? sqlName;
}

/** The columns named in a "Key (a, b)=(...)" detail. */
function keyColumns(detail: string | undefined): string[] {
  const m = detail ? /Key \(([^)]+)\)=/.exec(detail) : null;
  return m ? m[1]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")) : [];
}

/**
 * What a write error was, as the fields it names and a message key: with
 * fields, the key is the clause that follows "field: "; without, a sentence
 * of its own.
 */
function writeProblem(entity: AdminEntity, err: unknown): { fields: string[]; key: string } {
  const e = (err ?? {}) as PgError;
  const fields = () => keyColumns(e.detail).map((c) => fieldFor(entity, c));
  switch (e.code) {
    case "23505": {
      const f = fields();
      return { fields: f, key: f.length ? "dbError.duplicate" : "dbError.duplicateNoField" };
    }
    case "23503":
      return { fields: fields(), key: "dbError.missingRef" };
    case "23502":
      return e.column
        ? { fields: [fieldFor(entity, e.column)], key: "dbError.required" }
        : { fields: [], key: "dbError.requiredNoField" };
    case "23514":
      return { fields: [], key: "dbError.check" };
    case "22P02":
    case "22007":
    case "22008":
      return { fields: [], key: "dbError.format" };
    case "22001":
      return { fields: [], key: "dbError.tooLong" };
    default:
      return { fields: [], key: "dbError.unknown" };
  }
}

/**
 * `field: what is wrong`, from a Postgres error; a generic sentence for
 * anything unrecognised (the full error still goes to the server log).
 * `field` / `fieldMessage` are set when exactly one field is named, for the
 * form to show under that input.
 */
export function describeWriteError(
  t: Translate,
  entity: AdminEntity,
  err: unknown,
): { text: string; field?: string; fieldMessage?: string } {
  const { fields, key } = writeProblem(entity, err);
  const message = t(key);
  if (fields.length === 0) return { text: message };
  const text = t("fieldMessage", { field: fields.join(", "), message });
  return fields.length === 1 ? { text, field: fields[0], fieldMessage: message } : { text };
}
