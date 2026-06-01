// Spec 122 — POST /api/helpdesk/tickets
//
// The HelpPanel's "Talk to a person" card has three buttons:
//   1. WhatsApp programme team → wa.me deep-link with a pre-filled message
//   2. Email admin              → mailto: with the page slug in the subject
//   3. Open helpdesk ticket     → POSTs here
//
// The lighter path (no new table): insert a notifications row for every active
// programme_admin user with `kind="helpdesk.ticket"`. The inbox view (spec 070)
// already renders notifications, so the admins see the ticket alongside their
// other operational events. Retention is handled by the spec 107 SM-8 cron.
//
// Method matrix:
//   POST                          → 200 { ok:true, delivered:number }
//   POST (no session)             → 401 { error:"unauthenticated" }
//   POST (malformed body)         → 400 { error:"validation_failed", issues }
//   GET / PUT / DELETE / PATCH    → 405 { error:"method_not_allowed" }
//
// SM-1 (audit on every mutation): writes action="helpdesk.ticket_opened" with
// metadata.{topic,pageSlug,deliveredTo}. Best-effort — a failed audit insert
// never breaks the user-facing flow.
//
// SM-7 (no PII): the request body is bounded to a few short strings (topic
// slug, page slug, free-text message ≤ 500 chars). We deliberately do not
// store learner names, video tokens, or any IDs that aren't already in the
// user's session.

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { notifications, users } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  topic: z.string().max(64).nullable().optional(),
  pageSlug: z.string().max(200).optional(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;
  const userName = session.user.name ?? session.user.email ?? "a user";

  const raw = await req.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
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
  const { topic = null, pageSlug = "/", message = null } = parsed.data;

  // Resolve programme_admin + super_admin recipients. We notify both roles
  // so a stuck end-user always reaches someone on-call.
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.active, true),
        inArray(users.role, ["programme_admin", "super_admin"] as const),
      ),
    );
  // The opener is excluded — there is no value in a ticket landing in your
  // own inbox.
  const recipients = admins.filter((u) => u.id !== userId);

  const subject = `Help request from ${userName} on ${pageSlug}`;
  const bodyText = message?.trim().length
    ? message
    : `Help request from ${userName}${topic ? ` (topic: ${topic})` : ""} on ${pageSlug}.`;

  let delivered = 0;
  if (recipients.length > 0) {
    const rows = recipients.map((u) => ({
      userId: u.id,
      kind: "helpdesk.ticket",
      subject,
      body: bodyText,
      entityType: "helpdesk",
      entityId: topic ?? pageSlug,
    }));
    const inserted = await db.insert(notifications).values(rows).returning({ id: notifications.id });
    delivered = inserted.length;
  }

  void recordAudit({
    action: "helpdesk.ticket_opened",
    entityType: "helpdesk",
    entityId: topic ?? pageSlug,
    metadata: { topic, pageSlug, deliveredTo: delivered },
  });

  return NextResponse.json({ ok: true, delivered }, { status: 200 });
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
