// POST /api/admin/gates/[slug]/rotate — rotates the section-gate password.
//
// Workflow Run 9 Tier A (spec 115) — closes the highest-impact frontend-parity
// gap: the JSX prototype admin.jsx::SectionGates surface (lines 285-325) renders
// a "Rotate" button per gate that, until this route landed, had no backend wire.
// The button is a native <form method="POST" action="/api/admin/gates/<slug>/rotate">
// rendered from /admin/gates (spec 115's companion UI page).
//
// What it does:
//   1. Gates by super_admin only — the password rotation is the single most
//      privileged action across the section-gate surface; only the deployment's
//      ~1-2 super_admins can rotate. programme_admin is explicitly NOT trusted
//      with rotation under SM-2 (gate grants ≤ 8h enforced at DB layer means
//      a programme_admin who rotates can lock out every staff member for 8h
//      and there's no rollback path other than DB surgery).
//   2. Generates a fresh 12-char alphanumeric+symbol password using
//      crypto.randomBytes (node:crypto, no new dep). The character pool is
//      [A-Za-z0-9!@#$%^&*] — symbols restricted to typeable-on-WhatsApp glyphs
//      so the share-via-WhatsApp companion endpoint can paste the plaintext
//      into a `wa.me/` URL without URL-escape surprises.
//   3. bcrypts at cost 10 (matching apps/web/src/lib/password.ts so the
//      /gate/[slug] verify path lights up the same compare codepath).
//   4. INSERTs a new section_gates row with version = max(version)+1 and
//      rotatedByUserId = session.user.id. The existing row stays in the table
//      so already-issued grants aren't immediately broken (the lib/gates.ts
//      getCurrentGate() helper sorts by version DESC and returns the new row;
//      old grants expire via the 8h SM-2 ceiling regardless).
//   5. DELETEs every active section_gate_grants row for this slug so every
//      user has to re-unlock with the new password. Without this step a stale
//      grant cookie would let a user with the old password keep working for
//      up to 8 hours after the rotation — that's the exact scenario rotation
//      is supposed to prevent (compromised credential containment).
//   6. Audits "gate.password.rotated" with metadata {slug, version, by}.
//   7. Returns 200 JSON with the plaintext password ONCE. Admin sees the
//      plaintext in a modal on /admin/gates, copies/shares it, then the
//      plaintext is gone (the response is not cached; the modal closes;
//      reloading the page re-renders the row with a placeholder "[set]"
//      affordance). This is the conventional rotate-then-reveal pattern from
//      Stripe-style API key rotation.
//
// Method matrix:
//   POST                        → 200 { ok:true, plaintext:string, version:int }
//   POST (no session)           → 401 { error:"unauthenticated" }
//   POST (role != super_admin)  → 403 { error:"forbidden" }
//   POST (unknown slug)         → 400 { error:"invalid_slug" }
//   GET / PUT / DELETE / PATCH  → 405 { error:"method_not_allowed" }
//
// SM-2 (section-gate substrate moat): the 8h grant ceiling is a DB CHECK
// constraint, so even if this route forgot to DELETE the grants the worst-case
// stale window is 8h. The DELETE makes the worst-case rotation latency 0.
//
// SM-7 (no PII): the response carries the plaintext password (admin's choice
// to expose, by definition); no learner-side PII is touched.
//
// Workflow Run 13 — spec 148 (gate-rotate-transaction): the INSERT new
// section_gates row + DELETE old section_gate_grants pair is now wrapped in
// `db.transaction(async (tx) => { ... })` so the two writes commit or roll
// back atomically. Before spec 148 these were two separate statements with
// a <1ms race window in which a parallel /gate/[slug] verify could compare
// against the freshly-inserted hash and pick up a grant *that the rotation
// route was about to invalidate* one statement later. The window was small
// but real, and under the SM-2 substrate-moat threat model (compromised
// password containment) any non-zero race window on rotation is a real
// regression. The transaction closes the window: either both writes land
// (rotation effective, grants flushed) or neither (caller retries on a
// known-good state). The audit `recordAudit` still fires AFTER the tx
// returns — auditing the commit, not a tentative intent, and ensuring
// audit-write failure cannot trigger a rollback of the rotation itself.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq, max } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@gml/db";
import { sectionGates, sectionGateGrants } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin"] as const;
const VALID_SLUGS = ["mentorship", "observation", "admin", "tkt", "ttt"] as const;
type GateSlug = (typeof VALID_SLUGS)[number];

// Typeable-on-WhatsApp symbol set — no quotes, no backslash, no angle brackets.
const CHARSET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ" + // omit I, O for legibility
  "abcdefghijkmnopqrstuvwxyz" + // omit l for legibility
  "23456789" + // omit 0, 1 for legibility
  "!@#$%^&*";
const PASSWORD_LENGTH = 12;

function generatePassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  // Auth gate — no session → 401 (JSON, never redirect — API route).
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Role gate — super_admin ONLY. programme_admin gets 403.
  if (!ALLOWED_ROLES.includes(session.user.role as (typeof ALLOWED_ROLES)[number])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await ctx.params;
  if (!VALID_SLUGS.includes(slug as GateSlug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  const gateSlug = slug as GateSlug;

  // Generate fresh plaintext password and bcrypt it at cost 10
  // (same cost as apps/web/src/lib/password.ts so the verify path is uniform).
  const plaintext = generatePassword();
  const passwordHash = await bcrypt.hash(plaintext, 10);

  // Determine next version = max(version) + 1. We SELECT first because the
  // section_gates row count per slug is tiny (one per rotation, lifetime) and
  // an explicit version is cleaner than a unique-violation retry loop.
  const [latest] = await db
    .select({ v: max(sectionGates.version) })
    .from(sectionGates)
    .where(eq(sectionGates.slug, gateSlug));
  const nextVersion = (latest?.v ?? 0) + 1;

  // Spec 148 — wrap INSERT new section_gates row + DELETE old
  // section_gate_grants in a single db.transaction so the two writes commit or
  // roll back atomically. Before the transaction wrapper landed there was a
  // <1ms race window where a parallel /gate/[slug] verify could compare
  // against the new hash, get a grant cookie, and then have that grant
  // survive — defeating the rotation's containment goal. Both `tx.insert`
  // and `tx.delete` use the same tx so either both land or neither do.
  //
  // INSERT keeps the old row(s) so already-issued grants don't break on
  // rotation (they still expire via the 8h SM-2 ceiling). The DELETE flushes
  // every active grant for this slug — without it a stale grant on the old
  // password would survive for up to 8h, defeating the rotation. We don't
  // bother filtering by expiresAt > now() — over-deleting an already-expired
  // grant is harmless (the row was about to be reaped anyway), and the index
  // is keyed on (userId, gateSlug, expiresAt) so the unfiltered DELETE is
  // still cheap.
  const deleted = await db.transaction(async (tx) => {
    await tx.insert(sectionGates).values({
      slug: gateSlug,
      passwordHash,
      version: nextVersion,
      rotatedAt: new Date(),
      rotatedByUserId: session.user.id,
    });
    return tx
      .delete(sectionGateGrants)
      .where(eq(sectionGateGrants.gateSlug, gateSlug))
      .returning({ id: sectionGateGrants.id });
  });

  // Audit hook (SM-1): records the rotation with the version and the count
  // of grants invalidated. Best-effort `void` — audit failure never blocks
  // the user-facing 200 (the rotation already committed; logging the audit
  // miss to stderr is the right failure mode).
  void recordAudit({
    action: "gate.password.rotated",
    entityType: "section_gate",
    entityId: gateSlug,
    metadata: {
      slug: gateSlug,
      version: nextVersion,
      by: session.user.id,
      grantsInvalidated: deleted.length,
    },
  });

  return NextResponse.json(
    { ok: true, plaintext, version: nextVersion },
    { status: 200 },
  );
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
