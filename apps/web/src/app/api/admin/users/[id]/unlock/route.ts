// Spec 161 — POST /api/admin/users/[id]/unlock
//
// Super-admin-only endpoint to clear an account lockout early. The user
// can also wait out the 1-hour lockout window, but a super_admin has to
// be able to unblock a teacher mid-class (the lockout is generous on
// purpose — 5 misses in an hour — so this manual override should be
// rare).
//
// Contract:
//   — POST (no body required)
//   — requireRole(["super_admin"]) — anything else 403/redirect via the
//     existing guard helper.
//   — Sets failed_login_count = 0 and locked_until = NULL in a single
//     UPDATE.
//   — Audit `auth.account.unlocked` with metadata { unlockedBy: actor.id }
//     so the post-hoc story is "actor X cleared lockout for user Y".

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireRole(["super_admin"]);
  const { id } = await ctx.params;

  // Spec 161 — basic UUID shape check so a malformed path doesn't burn a
  // round-trip to Postgres. The error response is opaque (404) so a
  // probing attacker can't tell "this id-shaped path matched no user"
  // from "this id was malformed".
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, id));

  void recordAudit({
    userId: session.user.id,
    action: "auth.account.unlocked",
    entityType: "user",
    entityId: id,
    metadata: { unlockedBy: session.user.id },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
