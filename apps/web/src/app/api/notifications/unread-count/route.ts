// Spec 128 — GET /api/notifications/unread-count
//
// Lightweight wrapper around `loadUnreadNotifications` for client-side
// polling. A small client island (mounted by future spec) hits this endpoint
// every 30s to refresh the topbar bell chip without forcing a full layout
// rerender. The server-rendered chrome already shows the count on first
// paint; this endpoint exists so the chip stays fresh between navigations.
//
// Method matrix:
//   GET                          → 200 { count: number }
//   GET (no session)             → 401 { error: "unauthenticated" }
//   POST / PUT / DELETE / PATCH  → 405 { error: "method_not_allowed" }
//
// SM-7 (no PII leak): only a number is returned. No names, no notification
// bodies. The endpoint is scoped to the caller's user_id via `auth()`.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadUnreadNotifications } from "@/lib/chrome-counts";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const count = await loadUnreadNotifications(session.user.id);
  return NextResponse.json({ count }, { status: 200 });
}

export async function POST() {
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
