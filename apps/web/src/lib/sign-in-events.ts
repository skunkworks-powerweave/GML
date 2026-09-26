// Sign-in events: the audit rows and the users.last_seen_at stamp.
//
// WHAT WAS MISSING. The audit log is a hard requirement, but a sign-in, a failed
// sign-in, a sign-out and a recovery-link reset wrote nothing -- there was no
// recordAudit anywhere in auth.ts, app/login/** or app/auth/**. And the
// last_seen_at bump lived in the removed Auth.js signIn callback, so
// /admin/users said "never signed in" for every account, to administrators
// deciding whether to offboard a dormant account.
//
// Called by loginAction and the two email-link routes. Sign-out is recorded in
// auth.ts signOut(), the reset in /login/reset's action. Never throws: an audit
// outage must not stop someone signing in (recordAudit's own contract).

import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";

export type SignInMethod = "password" | "email_link" | "recovery_link";

/** A successful sign-in: one audit row, and the profile's last_seen_at. */
export async function recordSignIn(userId: string, method: SignInMethod): Promise<void> {
  const wrote = await recordAudit({
    action: "auth.sign_in",
    entityType: "user",
    entityId: userId,
    userId,
    metadata: { method },
  });
  if (!wrote) noteAuditDegraded("sign-in-events/recordSignIn");
  try {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
  } catch (err) {
    console.error(`[auth] could not stamp last_seen_at for ${userId}:`, err);
  }
}

/**
 * A sign-in that reached the credential check and failed.
 *
 * The address is stored as a short hash, never as typed: it is whatever a
 * stranger chose to submit, the audit log is readable by every administrator,
 * and repeated attempts at one address still correlate. No account is looked
 * up -- resolving the address to a user would be the membership oracle the
 * login page avoids. Callers skip throttled attempts, so the number of rows an
 * attacker can add is bounded by the sign-in throttle (auth.ts).
 *
 * `userId: null`, not omitted: a failed attempt does not clear the browser's
 * existing session, and recordAudit would otherwise credit the attempt to
 * whoever was left signed in on that (often shared) computer.
 */
export async function recordSignInFailure(email: string, reason: string): Promise<void> {
  await recordAudit({
    action: "auth.sign_in_failed",
    entityType: "auth",
    userId: null,
    metadata: { reason, emailHash: emailHash(email) },
  });
}

/** First 16 hex characters of SHA-256 over the normalised address. */
export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}
