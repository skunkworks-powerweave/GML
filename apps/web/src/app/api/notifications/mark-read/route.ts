// Spec 096 — POST /api/notifications/mark-read
//
// Closes the loop opened by spec 070's `/inbox` page: the "Mark all read"
// button there is a native HTML form (`<form action="/api/notifications/mark-read"
// method="post">`). This endpoint flips `read_at` from NULL → now() on the
// caller's unread notifications.
//
// Body shapes:
//   - empty / no JSON  → mark ALL unread notifications for the current user
//   - { ids: string[] } → mark only the specified ids (still scoped to the user)
//
// Method matrix:
//   POST                          → 200 { ok:true, marked:number }
//   POST (no session)             → 401 { error:"unauthenticated" }
//   POST (malformed `ids`)        → 400 { error:"validation_failed", issues }
//   GET / PUT / DELETE / PATCH    → 405 { error:"method_not_allowed" }
//
// SM-1 (audit on every mutation): writes action="notifications.mark_read"
// with entityType="notifications" and metadata.markedCount = rows touched.
// The audit insert is best-effort (see `recordAudit` contract) — a failed audit
// never breaks the user-facing flow.
//
// SM-7 (no PII leak): response carries only `{ok, marked}`. The notifications
// table holds operational events keyed on user_id; no learner-name columns are
// touched on this surface.
//
// SM-8 (retention): retention is enforced by the daily cleanup script
// (packages/db/src/scripts/retention.ts). This endpoint never inserts rows.

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { notifications } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { publicUrl } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

// Body parser tolerates: no body, empty body, `{}`, or `{ ids: [...] }`.
const BodySchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // Tolerate empty / non-JSON bodies — HTML form posts arrive with no payload.
  const raw = await req.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      // Treat unparseable body as empty (mark-all). The form-post path lands here.
      body = {};
    }
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const ids = parsed.data.ids;
  const now = new Date();

  // Always scope to the current user — clients cannot read someone else's notifications.
  // When `ids` is provided, narrow further with inArray; an empty array short-circuits to 0 rows.
  const whereClause =
    ids && ids.length > 0
      ? and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          inArray(notifications.id, ids),
        )
      : and(eq(notifications.userId, userId), isNull(notifications.readAt));

  const updated = await db
    .update(notifications)
    .set({ readAt: now })
    .where(whereClause)
    .returning({ id: notifications.id });

  void recordAudit({
    action: "notifications.mark_read",
    entityType: "notifications",
    metadata: { markedCount: updated.length, scope: ids ? "ids" : "all" },
  });

  // HTML form post (Content-Type: application/x-www-form-urlencoded) → 303 back
  // to /inbox so the page refreshes and the unread badge clears. JSON callers
  // (fetch with Content-Type: application/json) get the structured response.
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    // The public origin: req.url is Next's bind address behind Caddy.
    return NextResponse.redirect(await publicUrl("/inbox"), 303);
  }
  return NextResponse.json({ ok: true, marked: updated.length }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function PUT() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function PATCH() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
