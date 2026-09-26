// Small audit_log lookups that admin pages run on EVERY load.
//
// Here rather than inline in the pages because their cost is the point: the
// table is append-only and never pruned (_post/001, _post/007), so a lookup
// that reads rows in proportion to it gets slower every day and never
// recovers. tests/behaviour/admin-audit-lookups.test.ts counts the rows each
// one reads. (A page file may only export its component and route config.)

import { desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as appDb } from "@gml/db";
import { auditLog } from "@gml/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

/**
 * The actions recorded in the last `days` days, for /admin/audit's filter.
 *
 * This was `SELECT DISTINCT action ... WHERE created_at >= now() - 90 days`,
 * which reads every row of those 90 days: 1.9 s at 2M rows. The 90 days capped
 * the age of what it read, not the amount.
 *
 * A loose index scan instead: walk audit_log_action_created_idx (action,
 * created_at) one distinct action at a time -- each step is "the first action
 * after this one", a single index probe -- and keep an action if one probe of
 * the same index finds a row inside the window. The cost is two probes per
 * distinct action, a few dozen, whatever the table holds. Same answer, same
 * order (the index's collation, as ORDER BY action used).
 */
export async function recentAuditActions(days = 90, db: Db = appDb): Promise<string[]> {
  const { rows } = await db.execute<{ action: string }>(sql`
    WITH RECURSIVE actions(action) AS (
      (SELECT action FROM audit_log ORDER BY action LIMIT 1)
      UNION ALL
      SELECT (SELECT a.action FROM audit_log a WHERE a.action > actions.action ORDER BY a.action LIMIT 1)
      FROM actions
      WHERE actions.action IS NOT NULL
    )
    SELECT action FROM actions
    WHERE action IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM audit_log r
        WHERE r.action = actions.action
          AND r.created_at >= now() - make_interval(days => ${days})
      )
    ORDER BY action`);
  return rows.map((r) => r.action);
}

/**
 * The audit action a successful run of each host job writes
 * (docs/audit-actions.md, backup.* / restore.*).
 *
 * scripts/backup.sh and scripts/restore.sh append it at the end of each
 * successful run (scripts/lib/audit-host-job.sh), best effort: a box whose
 * jobs have not run since they started to, or could not reach the database,
 * has none, and the page then says where the host records the last run.
 */
export const HOST_JOB_SUCCESS_ACTION = {
  backup: "backup.complete",
  restore: "restore.complete",
} as const;

/**
 * When the latest successful backup / restore drill was recorded, for
 * /admin/system-settings.
 *
 * This was `action LIKE 'backup.%'`: under the database's en_US.UTF-8
 * collation a btree cannot serve a LIKE prefix, so it scanned the whole table
 * -- twice per render, and all of it, since no row ever matched. It also
 * counted `backup.failed` as the last successful backup. An exact action is
 * one backward probe of (action, created_at).
 */
export async function lastAuditAt(kind: keyof typeof HOST_JOB_SUCCESS_ACTION, db: Db = appDb): Promise<Date | null> {
  const [row] = await db
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, HOST_JOB_SUCCESS_ACTION[kind]))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row?.at ?? null;
}
