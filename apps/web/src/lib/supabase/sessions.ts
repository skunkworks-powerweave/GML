// Ending another user's sessions, by user id.
//
// WHY NOT auth.admin.signOut(). Its signature is signOut(JWT, scope): the first
// argument is sent to POST /logout as the bearer token, so it can only end the
// sessions of whoever that access token belongs to. The admin actions passed a
// user id; GoTrue answered 403 bad_jwt every time, auth-js RETURNED the error
// rather than throwing it, and a `.catch(() => undefined)` that could never
// fire hid the failure -- while the audit row recorded sessionsEnded: true.
// Demoted administrators kept administering, and a deactivated account's
// sessions came back to life on reactivation. GoTrue has no admin endpoint that
// ends sessions by user id.
//
// WHAT THIS DOES INSTEAD. GoTrue keeps a session per sign-in in auth.sessions,
// and each refresh token references its session ON DELETE CASCADE. Deleting
// the rows is exactly what GoTrue's own global logout does: every refresh token
// the user holds stops working on the next refresh. The application's database
// role (`postgres` on Supabase) holds DELETE on auth.sessions -- verified
// against the local stack with \dp, and data changes in the auth schema remain
// permitted on hosted projects.
//
// What it cannot do is recall an access token already issued: that is verified
// locally and lives until it expires. auth() closes that window for the
// administrative roles by confirming them against public.users (see auth.ts);
// README-deploy §2.2 bounds it for everyone else.

import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@gml/db";

export type RevokeResult = { ok: true; ended: number } | { ok: false; error: string };

/** End every session `userId` holds, on every device. Never throws. */
export async function revokeAllSessions(userId: string): Promise<RevokeResult> {
  try {
    const res = await db.execute(sql`DELETE FROM auth.sessions WHERE user_id = ${userId}::uuid`);
    return { ok: true, ended: Number((res as { rowCount?: number | null }).rowCount ?? 0) };
  } catch (err) {
    // Reported, not swallowed: the caller records the outcome it actually got.
    console.error(`[auth] could not end the sessions of ${userId}:`, err);
    return { ok: false, error: String(err).slice(0, 200) };
  }
}
