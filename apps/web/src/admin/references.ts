// Foreign keys in the admin grid, shown and picked by NAME rather than by UUID.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// "Admin-editable no-code tables" is a hard requirement, and 18 of the grid's
// entities link to another row by UUID. Every one of those links was a free
// text box: to pair a mentor with a teacher, put a school in a zone or a term
// in a phase, an administrator had to find a UUID somewhere and paste it --
// and the grid then showed that UUID back instead of a name, so a mistyped id
// could not be spotted either. (The teachers form even said "copy the id from
// /admin/data/phases", a page that did not exist.)
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Nothing is declared per entity. The Drizzle table already knows which of its
// columns are foreign keys and what they point at (getTableConfig), so every
// FK field is found here; LABELS says how a row of each referenced table is
// named. The form gets a <select> of the referenced rows and still SUBMITS THE
// UUID, so validation, CSV import and export are unchanged. The grid replaces
// each FK cell with the referenced row's label.
//
// Only the FK fields the page shows or edits are looked up, and a table whose
// rows a section password guards (observation cycles) is named only for a
// viewer holding that password -- see RefContext.
//
// Takes the database as a parameter so tests/behaviour can run it on a
// rolled-back transaction.

import "server-only";
import { and, asc, eq, getTableColumns, getTableName, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type AnyPgTable, type PgColumn } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as s from "@gml/db/schema";
import type { GateSlug } from "@/lib/gates";
import { ADMIN_ENTITIES } from "./registry";
import type { AdminEntity } from "./types";

type Db = NodePgDatabase<Record<string, unknown>>;

export type RefOption = { id: string; label: string };

/** What the viewer may see named. */
export type RefContext = {
  /** Whether the viewer holds an active grant for `gate` (lib/gates.ts getActiveGrant). */
  gateOpen: (gate: GateSlug) => Promise<boolean>;
};

/**
 * A select stays usable up to about this many options on a phone on a slow
 * link; past it the field falls back to a UUID box (with the current value's
 * name shown), rather than shipping an unbounded list with every page.
 */
export const REF_OPTION_LIMIT = 1000;

type LabelSource = {
  table: AnyPgTable;
  id: PgColumn;
  label: SQL<string>;
  /** A second table the label needs (a term is named by its phase too). */
  join?: { table: AnyPgTable; on: SQL };
  /** Rows the picker leaves out (soft-deleted accounts). */
  hide?: SQL;
};

/** How a row of each referenceable table is named, keyed by SQL table name. */
const LABELS: Record<string, LabelSource> = {
  districts: { table: s.districts, id: s.districts.id, label: sql<string>`${s.districts.name}` },
  zones: { table: s.zones, id: s.zones.id, label: sql<string>`${s.zones.name}` },
  schools: {
    table: s.schools,
    id: s.schools.id,
    label: sql<string>`${s.schools.name} || ' (' || ${s.schools.code} || ')'`,
  },
  teachers: { table: s.teachers, id: s.teachers.id, label: sql<string>`${s.teachers.fullName}` },
  mentors: { table: s.mentors, id: s.mentors.id, label: sql<string>`${s.mentors.name}` },
  // Accounts are named by person AND address: two staff can share a name, and
  // the address is what the person signs in with.
  users: {
    table: s.users,
    id: s.users.id,
    label: sql<string>`CASE WHEN coalesce(${s.users.name}, '') = '' THEN ${s.users.email}
      ELSE ${s.users.name} || ' <' || ${s.users.email} || '>' END`,
    hide: isNull(s.users.deletedAt),
  },
  phases: { table: s.phases, id: s.phases.id, label: sql<string>`${s.phases.label}` },
  // "Term 1" exists in every phase, so a term alone is ambiguous.
  terms: {
    table: s.terms,
    id: s.terms.id,
    label: sql<string>`${s.phases.label} || ' · ' || ${s.terms.name}`,
    join: { table: s.phases, on: eq(s.phases.id, s.terms.phaseId) },
  },
  rtt_subjects: { table: s.rttSubjects, id: s.rttSubjects.id, label: sql<string>`${s.rttSubjects.name}` },
  rtt_modules: { table: s.rttModules, id: s.rttModules.id, label: sql<string>`${s.rttModules.title}` },
  rtt_sessions: { table: s.rttSessions, id: s.rttSessions.id, label: sql<string>`${s.rttSessions.title}` },
  subjects: { table: s.subjects, id: s.subjects.id, label: sql<string>`${s.subjects.name}` },
  // Likewise "Grade 3" exists in every school.
  classes: {
    table: s.classes,
    id: s.classes.id,
    label: sql<string>`${s.schools.name} || ' · Grade ' || ${s.classes.grade}`,
    join: { table: s.schools, on: eq(s.schools.id, s.classes.schoolId) },
  },
  course_outlines: { table: s.courseOutlines, id: s.courseOutlines.id, label: sql<string>`${s.courseOutlines.name}` },
  outline_lessons: {
    table: s.outlineLessons,
    id: s.outlineLessons.id,
    label: sql<string>`'#' || ${s.outlineLessons.sequence} || ' ' || ${s.outlineLessons.title}`,
  },
  resources: { table: s.resources, id: s.resources.id, label: sql<string>`${s.resources.name}` },
  observation_cycles: {
    table: s.observationCycles,
    id: s.observationCycles.id,
    label: sql<string>`${s.observationCycles.code}`,
  },
};

/**
 * Every field of `entity` that is a single-column foreign key to a table this
 * module can name, mapped to that table's SQL name.
 */
export function referenceFields(entity: AdminEntity): Record<string, string> {
  const columns = Object.entries(getTableColumns(entity.table) as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const fk of getTableConfig(entity.table as never).foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length !== 1) continue;
    const key = columns.find(([, col]) => col === ref.columns[0])?.[0];
    const target = getTableName(ref.foreignTable);
    if (key && LABELS[target]) out[key] = target;
  }
  return out;
}

function labelQuery(db: Db, src: LabelSource) {
  const q = db.select({ id: src.id, label: src.label }).from(src.table as never).$dynamic();
  return src.join ? q.innerJoin(src.join.table as never, src.join.on) : q;
}

/** The section gate guarding a table's rows: the gate of the entity that administers it. */
function gateOfTable(target: string): GateSlug | undefined {
  return Object.values(ADMIN_ENTITIES).find((e) => e.gate && getTableName(e.table) === target)?.gate;
}

/**
 * The FK fields this page may name: those it shows or edits, and among them
 * only links into a gated table the viewer holds the password for.
 *
 * Every FK was looked up. rtt-attendance.markedByUserId is neither a column
 * nor a form field, and its picker -- up to 1,000 accounts' names and
 * addresses -- was queried and handed to the client form on every page load
 * for nothing. And observation cycles are named by code, so the UNgated
 * sessions grid listed every cycle's code, in its picker and its cells, to a
 * programme_admin who had never unlocked Observation. Such a field keeps its
 * id box and its cells their ids.
 */
async function visibleReferenceFields(entity: AdminEntity, ctx: RefContext): Promise<Record<string, string>> {
  const shown = new Set([...entity.formFields, ...entity.displayColumns.map((c) => c.key)]);
  const open = new Map<GateSlug, boolean>();
  const out: Record<string, string> = {};
  for (const [field, target] of Object.entries(referenceFields(entity))) {
    if (!shown.has(field)) continue;
    const gate = gateOfTable(target);
    // A grid behind the same gate has already required it (page.tsx).
    if (gate && gate !== entity.gate) {
      if (!open.has(gate)) open.set(gate, await ctx.gateOpen(gate));
      if (!open.get(gate)) continue;
    }
    out[field] = target;
  }
  return out;
}

/**
 * The picker options for each FK field of `entity` the page may name: every
 * referenceable row, named, in name order. A field whose target has more than
 * REF_OPTION_LIMIT rows maps to null, and the form keeps a UUID box for it.
 */
export async function referenceOptions(
  db: Db,
  entity: AdminEntity,
  ctx: RefContext,
): Promise<Record<string, RefOption[] | null>> {
  const out: Record<string, RefOption[] | null> = {};
  for (const [field, target] of Object.entries(await visibleReferenceFields(entity, ctx))) {
    const src = LABELS[target]!;
    // An account picker can be narrowed to the roles that make sense for the
    // link (an observation cycle's observer is an observer account).
    const roles = target === "users" ? entity.fields?.[field]?.userRoles : undefined;
    const filters = [src.hide, roles?.length ? inArray(s.users.role, roles) : undefined].filter(
      (f): f is SQL => Boolean(f),
    );
    const q = labelQuery(db, src);
    const rows = (await (filters.length ? q.where(and(...filters)) : q)
      .orderBy(asc(src.label))
      .limit(REF_OPTION_LIMIT + 1)) as Array<{ id: unknown; label: unknown }>;
    out[field] =
      rows.length > REF_OPTION_LIMIT
        ? null
        : rows.map((r) => ({ id: String(r.id), label: String(r.label ?? r.id) }));
  }
  return out;
}

/**
 * The edit form's pickers, with each field's CURRENT value among the options.
 *
 * An account picker lists only the roles the link is for and hides deleted
 * accounts, so a teacher record whose login had since been made a mentor (or
 * deleted) rendered its select with nothing selected. A browser then submits
 * the first option, "— none —", and the edit turned it into NULL: correcting
 * the teacher's phone number silently unlinked her login, and her cycles and
 * pairings with it. The current value is always offered, and says why it
 * would not otherwise be.
 */
export async function withCurrentValues(
  db: Db,
  entity: AdminEntity,
  options: Record<string, RefOption[] | null>,
  row: Record<string, unknown>,
): Promise<Record<string, RefOption[] | null>> {
  const fields = referenceFields(entity);
  const out = { ...options };
  for (const [field, list] of Object.entries(options)) {
    const id = row[field];
    if (!Array.isArray(list) || typeof id !== "string" || !id || list.some((o) => o.id === id)) continue;
    const src = LABELS[fields[field]!]!;
    const [named] = (await labelQuery(db, src).where(eq(src.id, id)).limit(1)) as Array<{ label: unknown }>;
    let why = "current value";
    if (fields[field] === "users") {
      const [account] = await db
        .select({ role: s.users.role, deletedAt: s.users.deletedAt })
        .from(s.users)
        .where(eq(s.users.id, id))
        .limit(1);
      const roles = entity.fields?.[field]?.userRoles;
      if (account?.deletedAt) why = "deleted account";
      else if (account && roles?.length && !roles.includes(account.role as never)) {
        why = `not a ${roles.join(" or ")} account`;
      }
    }
    out[field] = [{ id, label: `${String(named?.label ?? id)} (${why})` }, ...list];
  }
  return out;
}

/**
 * The label of every FK value in `rows` the page may name, per field:
 * `{ schoolId: { <uuid>: "GPS Chuchot (GPS-CHU)" } }`. One query per
 * referenced table, for the ids on this page only.
 */
export async function referenceLabels(
  db: Db,
  entity: AdminEntity,
  rows: Array<Record<string, unknown>>,
  ctx: RefContext,
): Promise<Record<string, Record<string, string>>> {
  const fields = await visibleReferenceFields(entity, ctx);
  const out: Record<string, Record<string, string>> = {};
  const idsByTarget = new Map<string, Set<string>>();
  for (const [field, target] of Object.entries(fields)) {
    for (const r of rows) {
      const v = r[field];
      if (typeof v === "string" && v) {
        if (!idsByTarget.has(target)) idsByTarget.set(target, new Set());
        idsByTarget.get(target)!.add(v);
      }
    }
  }
  const labelsByTarget = new Map<string, Map<string, string>>();
  for (const [target, ids] of idsByTarget) {
    const src = LABELS[target]!;
    const found = (await labelQuery(db, src).where(inArray(src.id, [...ids]))) as Array<{
      id: unknown;
      label: unknown;
    }>;
    labelsByTarget.set(target, new Map(found.map((r) => [String(r.id), String(r.label ?? r.id)])));
  }
  for (const [field, target] of Object.entries(fields)) {
    out[field] = Object.fromEntries(labelsByTarget.get(target) ?? []);
  }
  return out;
}
