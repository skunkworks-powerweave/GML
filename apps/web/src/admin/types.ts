import { z } from "zod";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RoleName } from "@gml/shared/auth/roles";
import type { GateSlug } from "@/lib/gates";

export type AdminDb = NodePgDatabase<Record<string, unknown>>;

/**
 * A sentence for the interface, as a key in the adminData translation
 * namespace plus its ICU values. The rules in these definitions run on the
 * server, in the CSV importer and in tests, none of which has the viewer's
 * translator to hand, so a rule names its message and whoever shows it
 * translates it (admin/labels.ts adminMessage).
 */
export type AdminMessage = { key: string; values?: Record<string, string | number> };

export type AdminColumn = {
  /**
   * Drizzle column key on the table (same as the JS field name). Its header
   * is `adminData.entities.<slug>.columns.<key>` (admin/labels.ts).
   */
  key: string;
  /** Optional formatter; defaults to JSON.stringify for non-primitives. */
  format?: (v: unknown) => string;
  /**
   * The values of a column that is shown but is not a form field, where it
   * holds a fixed set (a record's approval state): its cells and its filter
   * name them (`adminData.entities.<slug>.enum.<key>.<value>`), as a form
   * enum's are. A form field's choices come from its zod schema instead.
   */
  choices?: readonly string[];
};

/**
 * Optional presentation for one form field. Everything here has a working
 * default: foreign keys are found from the table itself (admin/references.ts)
 * and enums from the zod schema, so an entity only says what cannot be
 * derived. The words are in the translation bundles, not here: the form
 * label is `adminData.entities.<slug>.fields.<field>` (else the grid column's
 * header) and a line of guidance `.help.<field>` (admin/labels.ts).
 */
export type AdminFieldMeta = {
  /** For a link to a login account: only accounts with these roles are offered. */
  userRoles?: RoleName[];
  /**
   * A timestamp column that means a calendar DAY (a phase's start): edited
   * with a date picker instead of date-and-time. Stored as IST midnight, unless
   * the schema moves it (a phase's end is the end of that day).
   */
  input?: "date";
  /**
   * The field holds the Storage key of an uploaded file: the form offers a
   * file picker that uploads to /api/admin/data/<slug>/upload and fills the
   * key in (a resource's PDF). Only "pdf" exists; the route refuses any
   * entity that declares none.
   */
  upload?: "pdf";
};

export type AdminEntity<TTable extends AnyPgTable = AnyPgTable> = {
  /**
   * The URL segment, and the name of the entity's words in the translation
   * bundles: its title is `adminData.entities.<slug>.label` (admin/labels.ts).
   */
  slug: string;
  table: TTable;
  /** Roles that may read; mutate requires `mutateRoles` (defaults to read roles). */
  readRoles: RoleName[];
  mutateRoles?: RoleName[];
  /** Columns shown in the grid. */
  displayColumns: AdminColumn[];
  /** Zod schema for create/update form (server-side validation). */
  formSchema: z.ZodTypeAny;
  /** Field names included in the form (in this order). */
  formFields: string[];
  /** Per-field presentation (account roles, date pickers); see AdminFieldMeta. */
  fields?: Record<string, AdminFieldMeta>;
  /** Optional human-friendly identifier function for row labels in audit log. */
  describeRow?: (row: Record<string, unknown>) => string;
  /**
   * SM-9: when true, every server-side list/read of this entity writes an
   * `audit_log` row (action `<slug>.view`). Used for PII-bearing tables like
   * `learners`. The generic admin grid page checks this flag and calls
   * `recordAudit` after the DB fetch.
   */
  piiAudited?: boolean;
  /**
   * The prefix of the audit actions named after the entity (`<prefix>.view`
   * for a piiAudited read, `<prefix>.bulk_export`, `<prefix>.bulk_import`),
   * where the slug is not a valid action segment: docs/audit-actions.md
   * allows lowercase letters and underscores only. Defaults to the slug.
   */
  auditName?: string;
  /**
   * Columns the server sets on every grid or CSV write, whatever was
   * submitted: who marked a student's attendance, and when. Not form fields;
   * merged into the create and the update after validation.
   */
  writeStamp?: (ctx: { userId: string; op: "create" | "update" }) => Record<string, unknown>;
  /**
   * The section whose password guards these rows everywhere, not only under
   * /observation or /mentorship. lib/visibility.ts: a surface that re-serves a
   * gated section's rows must apply the gate too. When set, the grid page, all
   * four row actions and the CSV import/export require an active grant for it
   * (admin/access.ts), on top of the role check.
   */
  gate?: GateSlug;
  /**
   * Rules zod cannot check because they need the database (an observer id must
   * belong to a live observer account). Returns field -> message, or null.
   * Run by the create and update actions and by CSV import, after zod. On an
   * update `before` is the stored row the write replaces, so a rule can judge
   * only what changes: a value stored long ago may no longer pass (an account
   * since deactivated) and must not block an unrelated edit.
   */
  validate?: (
    db: AdminDb,
    row: Record<string, unknown>,
    before?: Record<string, unknown>,
  ) => Promise<Record<string, AdminMessage> | null>;
  /**
   * State-dependent write rules. Called by the grid's update (with the row as
   * it is and as it would become) and delete (with the row as it is), inside
   * the write's transaction and after the row is locked. Returns the reason
   * shown to the operator to refuse the write, or null to allow it.
   */
  guardMutation?: (
    op: "update" | "delete",
    before: Record<string, unknown>,
    next?: Record<string, unknown>,
  ) => AdminMessage | null;
  /**
   * CSV import only: the form fields that together say "this record is
   * already on the table", for a row added WITHOUT an id (a hand-made roster).
   * The first is required and must match; each later one is compared only
   * where both rows have it. Text is compared trimmed, case-folded and with
   * runs of spaces collapsed. A match -- with a stored row, or with an earlier
   * line of the same file -- is reported against its line and not added. Not
   * applied to the grid's Add row, where two people sharing a name is a
   * deliberate act.
   */
  duplicateKey?: string[];
};
