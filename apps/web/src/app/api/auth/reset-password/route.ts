// Spec 161 — POST /api/auth/reset-password
//
// Contract:
//   — Accept { token: string, password: string } JSON body.
//   — Look up password_reset_tokens by bcrypt-comparing the plaintext
//     token against every unconsumed-non-expired row. The volume is tiny
//     (<10 outstanding tokens org-wide) so the O(n) bcrypt-compare loop
//     dominates only by a couple of ms — acceptable for a rare flow.
//   — Validate: token row exists, not consumed, not expired, the
//     associated user is still active.
//   — On success: bcrypt-hash the new password at cost 10, UPDATE
//     users.passwordHash, mark the token consumedAt = now(), reset the
//     lockout counter to 0, clear locked_until. All inside a single
//     db.transaction so a partial failure doesn't leave the account in an
//     inconsistent state.
//   — Audit `auth.password.reset_completed` with the user id.
//   — Failure modes:
//       400 — missing or malformed body
//       410 — token not found, expired, or already consumed (one
//             response code for all three so a probing attacker can't
//             distinguish "I have a real token but it expired" from "I
//             have garbage")

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { users, passwordResetTokens } from "@gml/db/schema";
// Spec 167 — pull both `hashPassword` (which the new-password write uses
// directly) and the underlying `BCRYPT_COST` (recorded in the audit metadata
// so an investigator can see which bcrypt cost the row was hashed at without
// having to read the hash string itself). The import also documents the
// dependency: a future cost bump in lib/password.ts will surface in the audit
// row as soon as the next reset lands.
import { hashPassword, BCRYPT_COST } from "@/lib/password";
import { recordAudit, noteAuditDegraded } from "@/lib/audit";

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  let body: { token?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const password = String(body.password ?? "");
  if (!token || !password || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  // Spec 161 — fetch all unconsumed non-expired tokens. The bcrypt-
  // compare loop below identifies the matching row (or none). We DON'T
  // narrow the SELECT by tokenHash because we don't have the hash —
  // bcrypt hashes are not deterministic, so the only way to identify the
  // row given the plaintext is to compare each candidate.
  const now = new Date();
  const candidates = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      tokenHash: passwordResetTokens.tokenHash,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .where(
      and(
        isNull(passwordResetTokens.consumedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    );

  let matched: typeof candidates[number] | null = null;
  for (const row of candidates) {
    // bcrypt.compare is constant-time-ish per call; the loop bound (~10
    // candidates) keeps the wall-clock < 50ms.
    if (await bcrypt.compare(token, row.tokenHash)) {
      matched = row;
      break;
    }
  }

  if (!matched) {
    void recordAudit({
      action: "auth.password.reset_failed",
      entityType: "auth",
      ipOverride: ip,
      metadata: { reason: "token_invalid_or_expired" },
    });
    return NextResponse.json({ error: "token_invalid_or_expired" }, { status: 410 });
  }

  // Ensure the user is still active. A reset issued before an account was
  // deactivated should NOT silently revive the account.
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, matched.userId))
    .limit(1);
  if (!user || !user.active) {
    void recordAudit({
      action: "auth.password.reset_failed",
      entityType: "auth",
      ipOverride: ip,
      metadata: { reason: "user_inactive" },
    });
    return NextResponse.json({ error: "token_invalid_or_expired" }, { status: 410 });
  }

  const newHash = await hashPassword(password);

  // Spec 161 — transactional update. Three writes have to land together
  // or none: the password change itself, the token consumption (so a
  // second click on the same email link can't replay), and the lockout
  // reset (so an account that was locked when the reset was requested
  // gets a clean slate after the reset).
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: newHash,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, matched.userId));
    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(eq(passwordResetTokens.id, matched.id));
  });

  // Spec 167 — HIGH-STAKES audit: a password reset is one of the most
  // privileged account-mutation events, and the audit row is the only
  // forensic trail proving WHICH token landed on WHICH user with WHICH
  // bcrypt cost. On failure we noteAuditDegraded() but do NOT roll back
  // the password change — audit failure must not block a user from
  // recovering their account.
  const auditOk = await recordAudit({
    userId: matched.userId,
    action: "auth.password.reset_completed",
    entityType: "user",
    entityId: matched.userId,
    ipOverride: ip,
    metadata: { tokenId: matched.id, bcryptCost: BCRYPT_COST },
  });
  if (!auditOk) {
    noteAuditDegraded("/api/auth/reset-password");
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
