import { z } from "zod";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { RoleName } from "@gml/shared/auth/roles";

export type AdminColumn = {
  /** Drizzle column key on the table (same as the JS field name). */
  key: string;
  label: string;
  /** Optional formatter; defaults to JSON.stringify for non-primitives. */
  format?: (v: unknown) => string;
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
  /** Optional human-friendly identifier function for row labels in audit log. */
  describeRow?: (row: Record<string, unknown>) => string;
  /**
   * SM-9: when true, every server-side list/read of this entity writes an
   * `audit_log` row (action `<slug>.view`). Used for PII-bearing tables like
   * `learners`. The generic admin grid page checks this flag and calls
   * `recordAudit` after the DB fetch.
   */
  piiAudited?: boolean;
};
