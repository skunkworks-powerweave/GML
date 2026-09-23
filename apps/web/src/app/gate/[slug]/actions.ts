"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { db } from "@gml/db";
import { sectionGateGrants } from "@gml/db/schema";
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { getCurrentGate, type GateSlug } from "@/lib/gates";

// `admin` was ABSENT here, which made it unreachable: /gate/admin answered
// "Unknown section." for every attempt, so the gate could not be unlocked by
// anyone, ever -- while nav.ts rendered a padlock badge for it and
// /admin/gates offered a rotate button. `tkt` and `ttt` remain accepted
// because they are still members of the section_gate_slug enum, but nothing
// routes to them (see GATED_PREFIXES).
const VALID: GateSlug[] = ["mentorship", "observation", "admin", "tkt", "ttt"];

export type GateState = { error?: string };

// Spec 141: keep the generic outage copy in one place so we never leak the
// distinction between "Redis is down" and "audit channel is down" to the
// user. Both states map to the same response.
const SERVICE_UNAVAILABLE = "Service temporarily unavailable.";

/**
 * Only same-origin, absolute-path redirects are permitted.
 *
 * `next` arrives from the query string via a hidden form field, and was passed
 * straight to redirect(). `/gate/observation?next=https://evil.example` sent the
 * user off-site immediately after they entered a correct section password --
 * a convincing place to harvest credentials, since the victim has just proven
 * they will type one.
 *
 * Rejects protocol-relative URLs ("//evil.example", which the browser treats as
 * absolute) and anything not starting with a single "/".
 */
function safeNext(raw: string, fallback = "/dashboard"): string {
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  return raw;
}

export async function verifyGate(
  _prev: GateState | undefined,
  formData: FormData,
): Promise<GateState> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Sign in first." };

  const slug = String(formData.get("slug") ?? "") as GateSlug;
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  if (!VALID.includes(slug)) return { error: "Unknown section." };
  if (!password) return { error: "Enter a password." };

  // Rate limit.
  const hdr = await headers();
  const ip =
    hdr.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdr.get("x-real-ip") ??
    "unknown";

  // Spec 141: track whether the attempt was throttled (or would have been
  // had the channel been up) so the audit row captures the degraded state.
  let rateLimited = false;
  let attemptCount: number | undefined;

  // Spec 141: rate-limit fail-CLOSED. Previously a Redis fault silently
  // allowed unbounded gate-password guessing. Now a fault audits with a
  // SEVERE row and returns a generic "Service temporarily unavailable" so
  // ops can react without leaking the failure mode to attackers.
  try {
    const rl = await rateLimit({
      bucket: "gate",
      id: `${ip}:${session.user.id}:${slug}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    attemptCount = 5 - (rl.remaining ?? 0);
    if (!rl.ok) {
      rateLimited = true;
      void recordAudit({
        action: "gate.attempt.fail",
        entityType: "section_gate",
        entityId: slug,
        metadata: {
          slug,
          attemptCount,
          rateLimited: true,
          reason: "rate_limit_exceeded",
        },
      });
      const minutes = Math.ceil(rl.retryAfterMs / 60000);
      return { error: `Too many attempts. Try again in ${minutes} minutes.` };
    }
  } catch (err) {
    void recordAudit({
      action: "gate.rate_limit.redis_down",
      entityType: "section_gate",
      entityId: slug,
      metadata: {
        slug,
        severity: "SEVERE",
        error: String(err).slice(0, 200),
      },
    });
    return { error: SERVICE_UNAVAILABLE };
  }

  const gate = await getCurrentGate(slug);
  if (!gate) return { error: "Section not configured. Contact admin." };

  const ok = await bcrypt.compare(password, gate.passwordHash);
  if (!ok) {
    // Spec 141: audit every wrong-password attempt so /admin/gates can
    // surface attack patterns. Never include the plaintext.
    void recordAudit({
      action: "gate.attempt.fail",
      entityType: "section_gate",
      entityId: slug,
      metadata: {
        slug,
        attemptCount,
        rateLimited,
        reason: "wrong_password",
      },
    });
    return { error: "Wrong password." };
  }

  // Write grant.
  const grantedAt = new Date();
  const expiresAt = new Date(grantedAt.getTime() + 8 * 60 * 60 * 1000);
  await db.insert(sectionGateGrants).values({
    userId: session.user.id,
    gateSlug: slug,
    grantedAt,
    expiresAt,
    ip,
  });

  // Spec 141: success audit so /admin/gates attempts/failures stats are
  // accurate (the dashboard reads `gate.attempt.success` + `gate.attempt.fail`).
  void recordAudit({
    action: "gate.attempt.success",
    entityType: "section_gate",
    entityId: slug,
    metadata: {
      slug,
      attemptCount,
      rateLimited,
    },
  });

  // Cookie marker for middleware.
  const c = await cookies();
  c.set(`gml-gate-${slug}`, "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });

  redirect(safeNext(next));
}
