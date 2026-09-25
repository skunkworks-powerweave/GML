import { z } from "zod";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RoleName } from "@gml/shared/auth/roles";
import type { GateSlug } from "@/lib/gates";

export type AdminDb = NodePgDatabase<Record<string, unknown>>;

export type AdminColumn = {
  /** Drizzle column key on the table (same as the JS field name). */
  key: string;
  label: string;
  /** Optional formatter; defaults to JSON.stringify for non-primitives. */
  format?: (v: unknown) => string;
};

/**
 * Optional presentation for one form field. Everything here has a working
 * default: foreign keys are found from the table itself (admin/references.ts)
 * and enums from the zod schema, so an entity only says what cannot be
 * derived.
 */
export type AdminFieldMeta = {
  /** Form label. Defaults to the grid column's label, then the key spelled out. */
  label?: string;
  /** One line of guidance shown under the input. */
  help?: string;
  /** For a link to a login account: only accounts with these roles are offered. */
  userRoles?: RoleName[];
  /**
   * A timestamp column that means a calendar DAY (a phase's start): edited
   * with a date picker instead of date-and-time. Stored as IST midnight, unless
   * the schema moves it (a phase's end is the end of that day).
   */
  input?: "date";
};

export type AdminEntity<TTable extends AnyPgTable = AnyPgTable> = {
  slug: string;
  label: string;
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
  /** Per-field labels and hints; see AdminFieldMeta. */
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
  ) => Promise<Record<string, string> | null>;
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
  ) => string | null;
};
