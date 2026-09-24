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
import { getActiveGrant } from "@/lib/gates";
import type { AdminDb, AdminEntity } from "./types";

/** True when `entity` has no gate, or `userId` holds an active grant for it. */
export async function entityGateOpen(entity: AdminEntity, userId: string): Promise<boolean> {
  if (!entity.gate) return true;
  return Boolean(await getActiveGrant(userId, entity.gate));
}

/** The entity's database-backed field errors for a zod-valid row, or null. */
export async function entityRowProblems(
  entity: AdminEntity,
  row: Record<string, unknown>,
): Promise<Record<string, string> | null> {
  if (!entity.validate) return null;
  return entity.validate(db as unknown as AdminDb, row);
}
