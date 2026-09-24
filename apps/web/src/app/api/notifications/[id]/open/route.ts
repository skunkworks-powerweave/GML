// GET /api/notifications/[id]/open -- mark one notification read, then go to
// what it is about.
//
// Every /inbox item links here. Opening an item used to leave it unread
// ("Mark all read" was the only control), and an item with no entity link
// could not be opened or marked at all; it now returns to /inbox, read.
//
// A GET that writes, deliberately: it is a plain link, and what it writes is
// the caller's own read_at. The inbox renders these as <a>, not next/link, so
// a viewport prefetch can never mark a whole page read unopened.
//
// Always 303s. Not signed in -> /login. An id that is malformed or names
// someone else's notification changes nothing and lands on /inbox, so the
// response says nothing about whose ids exist.

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { notifications } from "@gml/db/schema";
import { auth } from "@/auth";
import { isUuid } from "@/lib/ids";
import { publicUrl } from "@/lib/safe-redirect";
import { hrefForEntity } from "@/app/(authenticated)/inbox/links";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(await publicUrl("/login?next=%2Finbox"), 303);
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.redirect(await publicUrl("/inbox"), 303);

  const [row] = await db
    .select({ entityType: notifications.entityType, entityId: notifications.entityId })
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, session.user.id)))
    .limit(1);
  if (!row) return NextResponse.redirect(await publicUrl("/inbox"), 303);

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, session.user.id), isNull(notifications.readAt)));

  return NextResponse.redirect(await publicUrl(hrefForEntity(row.entityType, row.entityId) ?? "/inbox"), 303);
}
