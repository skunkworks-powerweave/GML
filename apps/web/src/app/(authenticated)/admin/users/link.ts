// Linking a new login to an existing teacher or mentor record.
//
// A COMPARE-AND-SET, not an overwrite. createUserAction ran
//     UPDATE teachers SET user_id = <new> WHERE id = <record>
// with no check that the record was still unlinked. The "Link to" dropdown is
// rendered once per page load, so two admins onboarding the same roster (or one
// admin in two tabs) re-pointed a record linked moments earlier: the original
// teacher lost her whole programme -- teacherIdFor() returned nothing, so an
// empty dashboard and a 404 on her own cycles -- and the new account inherited
// her cycles, videos and mentorship data, with no error and no audit.
//
// The WHERE user_id IS NULL makes the claim atomic; migration 0031's unique
// indexes on teachers.user_id / mentors.user_id stop one login holding two
// records by any other path (grid edit, CSV import).
//
// A plain module taking the database, so tests/behaviour can run it on a
// rolled-back transaction; the "use server" action file cannot be loaded there
// without Supabase.

import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { mentors, teachers } from "@gml/db/schema";

type Db = NodePgDatabase<Record<string, unknown>>;

/** True if the record was unlinked and is now linked to `userId`; false otherwise. */
export async function linkAccountToRecord(
  db: Db,
  kind: "teacher" | "mentor",
  recordId: string,
  userId: string,
): Promise<boolean> {
  const table = kind === "teacher" ? teachers : mentors;
  const claimed = await db
    .update(table)
    .set({ userId, updatedAt: new Date() })
    .where(and(eq(table.id, recordId), isNull(table.userId)))
    .returning({ id: table.id });
  return claimed.length === 1;
}
