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

import { getTableColumns } from "drizzle-orm";
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
 * `field: what is wrong`, from a Postgres error; a generic sentence for
 * anything unrecognised (the full error still goes to the server log).
 */
export function describeWriteError(entity: AdminEntity, err: unknown): string {
  const e = (err ?? {}) as PgError;
  const fields = () => keyColumns(e.detail).map((c) => fieldFor(entity, c));
  switch (e.code) {
    case "23505": {
      const f = fields();
      return f.length ? `${f.join(", ")}: a row with this value already exists` : "a row with these values already exists";
    }
    case "23503": {
      const f = fields();
      return f.length ? `${f.join(", ")}: refers to a row that does not exist` : "refers to a row that does not exist";
    }
    case "23502":
      return e.column ? `${fieldFor(entity, e.column)}: is required` : "a required value is missing";
    case "23514":
      return "a value is outside what this table allows";
    case "22P02":
    case "22007":
    case "22008":
      return "a value is not in the format this column needs";
    case "22001":
      return "a value is too long for its column";
    default:
      return "the row could not be saved";
  }
}
