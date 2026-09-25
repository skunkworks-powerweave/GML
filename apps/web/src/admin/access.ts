// The section gate and the database-backed row rules, for every admin grid
// path that reaches an entity's rows.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// observation-cycles and mentor-pairings re-serve the rows /observation and
// /mentorship keep behind section passwords, and the grid checked the ROLE
// only. A programme_admin who had never unlocked Observation -- or whose grant
// a rotation had just revoked -- could list, export, import, edit and delete
// every cycle. So an entity declares `gate`, and every path checks it here:
// the grid page and row actions redirect to the unlock page
// (assertSectionGate), the CSV routes answer 403 gate_required.
//
// The same paths skipped /observation/new's rule that a cycle's observer must
// be a live observer account, so the grid or a CSV could point a cycle at a
// mentor; `validate` runs that rule (and any like it) after zod.

import "server-only";
import { db } from "@gml/db";
import { ADMIN_ROLES, type RoleName } from "@gml/shared/auth/roles";
import { getActiveGrant } from "@/lib/gates";
import type { AdminDb, AdminEntity } from "./types";

/**
 * Who may BULK-EXPORT an entity: its readers, but administrators only.
 *
 * The export authorised on readRoles, which says who may see the grid, and
 * several entities list non-admins there (mentor-pairings and rtt-attendance
 * list mentors; teachers lists mentors and observers; classes, subjects,
 * resources and sessions list teachers). The /admin pages were closed to them
 * by the proxy, but /api/* is not covered by it, so a mentor could download
 * every mentor's pairing roster -- which /mentorship scopes to the mentor's
 * own mentees -- and an observer every teacher's phone number. A whole-table
 * download is an administrative act; non-admin reads go through the scoped,
 * gated surfaces built for them (lib/gated-reads.ts).
 */
export function exportRolesFor(entity: AdminEntity): RoleName[] {
  return entity.readRoles.filter((r) => (ADMIN_ROLES as readonly string[]).includes(r));
}

/** True when `entity` has no gate, or `userId` holds an active grant for it. */
export async function entityGateOpen(entity: AdminEntity, userId: string): Promise<boolean> {
  if (!entity.gate) return true;
  return Boolean(await getActiveGrant(userId, entity.gate));
}

/**
 * The entity's database-backed field errors for a zod-valid row, or null.
 * `before` is the stored row an update replaces (absent on create); `conn` is
 * the transaction when the caller holds that row locked, so the check does not
 * wait on a second pool connection.
 */
export async function entityRowProblems(
  entity: AdminEntity,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
  conn: AdminDb = db as unknown as AdminDb,
): Promise<Record<string, string> | null> {
  if (!entity.validate) return null;
  return entity.validate(conn, row, before);
}
