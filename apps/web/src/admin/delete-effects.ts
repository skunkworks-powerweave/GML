// What else a grid delete changes, said in the delete's confirmation BEFORE it
// happens.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// deleteRowAction issues one DELETE and leaves the rest to the foreign keys.
// Since migration 0031 most of those refuse (the grid then says what still
// references the row), but some still act, silently:
//
//   ON DELETE CASCADE   the rows pointing at it are deleted too: an RTT lesson
//                       or reading takes every teacher's progress tick on it,
//                       a subject its resource tags, a student her attendance
//                       and marks, a grade scale its bands
//   ON DELETE SET NULL  they stay, with the link emptied: a phase is no longer
//                       any teacher's current phase, an outline lesson no
//                       longer any session's lesson, a module no longer any RTT
//                       session's, a teacher no longer owns her lesson plans
//
// The confirmation said only "Delete <row>? This cannot be undone."
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Nothing is declared per entity: every table in the Drizzle schema is
// scanned for foreign keys that point at the entity's table with one of those
// two rules -- the same definitions the migrations were generated from -- so
// a rule added or changed later is warned about without anyone remembering to.
// Each affected table (cascade) or link (set null) is named in the viewer's
// language, adminData.deleteEffects.removes.<table> and
// .unlinks.<table>.<column>; a registered entity with an effect and no words
// fails tests/behaviour/admin-platform-delete-warnings.test.ts.

import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable, type AnyPgTable } from "drizzle-orm/pg-core";
import * as schema from "@gml/db/schema";
import type { Translate } from "./labels";

export type DeleteEffect = {
  /** SQL name of the table whose rows are affected. */
  table: string;
  /** SQL name of its column that points at the deleted row. */
  column: string;
  action: "cascade" | "set null";
};

let tables: PgTable[] | null = null;

/** Every table the schema defines. */
function schemaTables(): PgTable[] {
  if (!tables) tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  return tables;
}

/** The foreign keys that delete or unlink rows elsewhere when a row of `table` is deleted. */
export function deleteEffects(table: AnyPgTable): DeleteEffect[] {
  const target = getTableName(table);
  const out: DeleteEffect[] = [];
  for (const t of schemaTables()) {
    const config = getTableConfig(t);
    for (const fk of config.foreignKeys) {
      const action = fk.onDelete;
      if (action !== "cascade" && action !== "set null") continue;
      const ref = fk.reference();
      if (getTableName(ref.foreignTable) !== target || ref.columns.length !== 1) continue;
      out.push({ table: config.name, column: ref.columns[0]!.name, action });
    }
  }
  // A stable order: what is deleted, then what is unlinked, by table.
  return out.sort((a, b) =>
    a.action === b.action ? `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`) : a.action === "cascade" ? -1 : 1,
  );
}

/** The message key naming one effect. */
export function effectKey(effect: DeleteEffect): string {
  return effect.action === "cascade"
    ? `deleteEffects.removes.${effect.table}`
    : `deleteEffects.unlinks.${effect.table}.${effect.column}`;
}

/**
 * The warning a delete of a row of `table` gives, in the viewer's language,
 * or null when it changes nothing else. The phrases are joined with the
 * language's own separator (deleteEffects.separator: "; ", or a shad in
 * Bhoti, which Intl.ListFormat does not know): a phrase may carry its own
 * comma or aside, so a comma list would not say where one ends.
 */
export function deleteWarning(t: Translate, table: AnyPgTable): string | null {
  const effects = deleteEffects(table);
  if (effects.length === 0) return null;
  const join = (items: string[]) => items.join(t("deleteEffects.separator"));
  // One phrase per effect; the same phrase twice (never, today) once.
  const removes = [...new Set(effects.filter((e) => e.action === "cascade").map((e) => t(effectKey(e))))];
  const unlinks = [...new Set(effects.filter((e) => e.action === "set null").map((e) => t(effectKey(e))))];
  const parts: string[] = [];
  if (removes.length) parts.push(t("deleteEffects.alsoRemoves", { items: join(removes) }));
  if (unlinks.length) parts.push(t("deleteEffects.alsoUnlinks", { items: join(unlinks) }));
  return parts.join(" ");
}
