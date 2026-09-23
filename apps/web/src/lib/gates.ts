// Section-gate helpers. Used by middleware (spec 008+009) and the gate-prompt
// page (spec 009).

import "server-only";
import { redirect } from "next/navigation";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@gml/db";
import { sectionGates, sectionGateGrants } from "@gml/db/schema";

// Mirrors the section_gate_slug enum in packages/db/src/schema/enums.ts.
// `admin` was omitted here, which is the type-level half of why that gate was
// inert: it could not be named in GATED_PREFIXES even if someone tried.
export type GateSlug = "mentorship" | "observation" | "admin" | "tkt" | "ttt";

export const GATED_PREFIXES: { prefix: string; slug: GateSlug }[] = [
  { prefix: "/mentorship", slug: "mentorship" },
  { prefix: "/observation", slug: "observation" },
  // The audit log. nav.ts has declared `gate: "admin"` on this item since it
  // was written and rendered a padlock badge for it, but the slug appeared in
  // no prefix list and was rejected by verifyGate -- so the padlock was purely
  // cosmetic and the most sensitive read surface in the product was guarded by
  // a role check alone. The enforcement is in admin/audit/layout.tsx; this
  // entry is what lets the proxy redirect quickly.
  { prefix: "/admin/audit", slug: "admin" },
  // '/rtt/tkt' and '/rtt/ttt' were listed here and have been removed: neither
  // route exists in the app. The RTT surfaces that actually ship are /rtt,
  // /rtt/subject/[id], /rtt/teach-back and /rtt/online/{a,}synchronous, none of
  // which is gated. Their gate passwords were therefore decorative.
];

export function gateForPath(pathname: string): GateSlug | null {
  const hit = GATED_PREFIXES.find(
    (p) => pathname === p.prefix || pathname.startsWith(p.prefix + "/"),
  );
  return hit?.slug ?? null;
}

/** Returns the current grant if any; null otherwise. */
export async function getActiveGrant(userId: string, slug: GateSlug) {
  const [row] = await db
    .select()
    .from(sectionGateGrants)
    .where(
      and(
        eq(sectionGateGrants.userId, userId),
        eq(sectionGateGrants.gateSlug, slug),
        gt(sectionGateGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sectionGateGrants.expiresAt))
    .limit(1);
  return row ?? null;
}

/** Returns the current active gate password row (latest version). */
export async function getCurrentGate(slug: GateSlug) {
  const [row] = await db
    .select()
    .from(sectionGates)
    .where(eq(sectionGates.slug, slug))
    .orderBy(desc(sectionGates.version))
    .limit(1);
  return row ?? null;
}

/**
 * Server-side section-gate enforcement.
 *
 * THE BUG THIS CLOSES. Authorization for a gated section was a cookie whose
 * value was compared to the literal string "1":
 *
 *     if (reqCookies?.get?.(`gml-gate-${slug}`)?.value !== "1") redirect(...)
 *
 * Unsigned, not bound to a user, and never checked against the database. Any
 * authenticated user could send `Cookie: gml-gate-observation=1` and walk
 * straight in -- verified against a running stack, see docs/verification.md.
 * `section_gate_grants` was written on every successful unlock and then read by
 * nothing: getActiveGrant() above had ZERO call sites.
 *
 * It also made password ROTATION a no-op. /api/admin/gates/[slug]/rotate
 * deletes the grant rows and its own comment says that is what stops "a stale
 * grant cookie" working -- but since the decision never consulted those rows,
 * every issued cookie kept working for its full 8 hours after a rotation.
 * "Section-level rotatable passwords" is a stated hard requirement of this
 * product.
 *
 * Reading the grant makes rotation real: delete the rows and the very next
 * request re-prompts. The cookie stays, but only as a fast-redirect UX hint in
 * the proxy -- it is no longer the authorization decision.
 *
 * This runs in a server LAYOUT rather than the proxy because getActiveGrant is
 * `server-only` and uses Drizzle. One indexed lookup per gated request
 * (section_gate_grants_user_slug_idx covers user_id, gate_slug, expires_at).
 */
export async function assertSectionGate(
  userId: string,
  slug: GateSlug,
  nextPath: string,
): Promise<void> {
  const grant = await getActiveGrant(userId, slug);
  if (!grant) {
    redirect(`/gate/${slug}?next=${encodeURIComponent(nextPath)}`);
  }
}
