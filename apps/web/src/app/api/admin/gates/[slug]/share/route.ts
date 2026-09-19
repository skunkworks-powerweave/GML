// POST /api/admin/gates/[slug]/share — builds a WhatsApp share URL for a
// freshly-rotated gate password and audits the intent.
//
// Workflow Run 9 Tier A (spec 115) companion to /rotate. The /admin/gates page
// shows a "Share via WhatsApp" button next to the rotate-result modal: the
// admin clicks Rotate, gets the plaintext password in the modal, clicks Share
// → this endpoint receives the recipient userId + the plaintext (echoed from
// the modal) and returns a `wa.me/<recipient-phone>?text=<urlencoded-msg>` URL
// that the modal then `window.open()`s in a new tab. WhatsApp's mobile/web
// client picks up the deep link, pre-fills the chat with the password, and
// the admin hits Send by hand. We deliberately do NOT auto-send — the human
// in the loop is the SM-7 PII-handling guarantee here, since the password
// will appear in the WhatsApp message history of both parties indefinitely
// and the admin should re-confirm the recipient before sending.
//
// What it does NOT do (out of scope for v1):
//   - Actually call the WhatsApp Cloud API. The /api/webhooks/whatsapp surface
//     (spec 043) is RECV-only; SEND-side is gated by spec 105's WhatsApp
//     queue enqueue, which is for video-receipt acknowledgement and not
//     gate-password distribution. A future spec can add a `wa-send` queue
//     and a `gate.password.share_sent` audit row; today the audit row is
//     `share_initiated` (admin opened the deep link, may or may not have
//     hit Send).
//   - Embed the password in a server-rendered HTML page. The plaintext is
//     never persisted; the response carries only the URL string with the
//     password already urlencoded.
//   - SMS / email channels. The request body's `channel` field is parsed
//     and validated to `"whatsapp"` (enum-of-one for now) so a future spec
//     can extend without changing the URL shape.
//
// Method matrix:
//   POST                           → 200 { ok:true, url:"https://wa.me/..." }
//   POST (no session)              → 401 { error:"unauthenticated" }
//   POST (role != super_admin)     → 403 { error:"forbidden" }
//   POST (invalid slug)            → 400 { error:"invalid_slug" }
//   POST (invalid body)            → 400 { error:"validation_failed", issues }
//   POST (recipient has no phone)  → 400 { error:"recipient_no_phone" }
//   GET / PUT / DELETE / PATCH     → 405 { error:"method_not_allowed" }
//
// SM-1 (audit): records "gate.password.share_initiated" with metadata
// {slug, recipientUserId, channel}. The plaintext password is NEVER written
// to audit_log — the audit row carries the intent, not the secret.
//
// SM-7 (no PII echo): response carries only the wa.me URL. The recipient's
// phone number is embedded in the URL (it has to be, per WhatsApp's deep-link
// spec), and the password is embedded in the urlencoded message — but neither
// the recipient's name nor any other identity column is echoed back.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@gml/db";
import { users } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin"] as const;
const VALID_SLUGS = ["mentorship", "observation", "admin", "tkt", "ttt"] as const;
type GateSlug = (typeof VALID_SLUGS)[number];

const BodySchema = z.object({
  recipientUserId: z.string().uuid(),
  channel: z.literal("whatsapp"),
  plaintext: z.string().min(1).max(64),
});

// Strip everything that isn't a digit. WhatsApp wa.me deep links require the
// international format with no +, spaces, or dashes (e.g. 911234567890).
function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, "");
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!ALLOWED_ROLES.includes(session.user.role as (typeof ALLOWED_ROLES)[number])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await ctx.params;
  if (!VALID_SLUGS.includes(slug as GateSlug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  const gateSlug = slug as GateSlug;

  // Tolerate empty / non-JSON bodies for diagnostic clarity.
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
  const { recipientUserId, channel, plaintext } = parsed.data;

  // Look up the recipient's phone number. We don't echo other PII back.
  const [recipient] = await db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, recipientUserId))
    .limit(1);
  if (!recipient) {
    return NextResponse.json({ error: "recipient_not_found" }, { status: 400 });
  }
  if (!recipient.phone) {
    return NextResponse.json({ error: "recipient_no_phone" }, { status: 400 });
  }

  const phone = normalizePhone(recipient.phone);
  if (!phone) {
    return NextResponse.json({ error: "recipient_no_phone" }, { status: 400 });
  }

  // Compose the wa.me deep link. The text is intentionally short — long
  // messages get truncated by some WhatsApp clients when arriving via a
  // pre-fill URL.
  const message =
    `[GML LMS] New ${gateSlug} gate password: ${plaintext} — rotate every 30 days.`;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;

  // Audit the intent. The plaintext password is NEVER stored in audit_log.
  void recordAudit({
    action: "gate.password.share_initiated",
    entityType: "section_gate",
    entityId: gateSlug,
    metadata: {
      slug: gateSlug,
      recipientUserId,
      channel,
      by: session.user.id,
    },
  });

  return NextResponse.json({ ok: true, url }, { status: 200 });
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
