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
//   POST (body not JSON)          → 400 { error:"invalid_json" }
//   POST (malformed body)         → 400 { error:"validation_failed", issues:[{path,message}] }
//   GET / PUT / DELETE / PATCH    → 405 { error:"method_not_allowed" }
//
// An EMPTY body is still a ticket with the defaults (every field is optional).
// A body that is not JSON is not: it used to be read as `{}` too, which put
// whatever a broken client or a script sent into every administrator's inbox.
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
import { publicIssues, readJsonBody } from "@/lib/api-json";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  topic: z.string().max(64).nullable().optional(),
  pageSlug: z.string().max(200).optional(),
  message: z.string().max(500).optional(),
});

// Spec 154 (audit-closure MEDIUM) — bucket / window for ticket throttling.
// 5 tickets per user per hour matches the WhatsApp + email backstop: a real
// stuck user opens 1-2 tickets before they reach a human; an automated
// abuser would burn through hundreds in a minute. The window slides on a
// per-user key (session.user.id) so a shared device / VPN doesn't collide.
const HELPDESK_LIMIT = 5;
const HELPDESK_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;
  const userName = session.user.name ?? session.user.email ?? "a user";

  // Spec 154 — throttle helpdesk ticket creation. The previous shape had no
  // rate limit at all, which meant a logged-in user could spam unlimited
  // notifications into every programme_admin's inbox. We fail OPEN on Redis
  // outage so a transient infra incident doesn't lock real stuck users out
  // of asking for help — the threat we're closing is the spam vector, not
  // the help-arrival path.
  try {
    const rl = await rateLimit({
      bucket: "helpdesk",
      id: userId,
      limit: HELPDESK_LIMIT,
      windowMs: HELPDESK_WINDOW_MS,
    });
    if (!rl.ok) {
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      void recordAudit({
        action: "helpdesk.ticket_rate_limited",
        entityType: "helpdesk",
        entityId: userId,
        metadata: { retryAfterMs: rl.retryAfterMs },
      });
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
          },
        },
      );
    }
  } catch (err) {
    // Redis down — log for ops, fall through so the user can still file a
    // ticket. The audit trail still records the ticket below, so abuse is
    // visible after-the-fact even when the throttle is degraded.
    console.warn("[helpdesk] rate-limit redis error — failing open", String(err));
  }

  const read = await readJsonBody(req, { allowEmpty: true });
  if (read.response) return read.response;
  const parsed = BodySchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: publicIssues(parsed.error) },
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

  // notifications.subject is varchar(200) and pageSlug is accepted up to 200
  // chars on its own, so the concatenation overflowed and the INSERT threw --
  // taking down the whole help-request submission for a long page slug, with
  // the user told only that their request failed. Truncated to fit, with the
  // slug the part that gives way: the requester's name is the load-bearing
  // half of the line.
  const subject = `Help request from ${userName} on ${pageSlug}`.slice(0, 200);
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
