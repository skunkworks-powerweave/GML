"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { db } from "@gml/db";
import { sectionGateGrants } from "@gml/db/schema";
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentGate, type GateSlug } from "@/lib/gates";

const VALID: GateSlug[] = ["mentorship", "observation", "tkt", "ttt"];

export type GateState = { error?: string };

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
  try {
    const rl = await rateLimit({
      bucket: "gate",
      id: `${ip}:${session.user.id}:${slug}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!rl.ok) {
      const minutes = Math.ceil(rl.retryAfterMs / 60000);
      return { error: `Too many attempts. Try again in ${minutes} minutes.` };
    }
  } catch {
    // Redis down → fail open with a warning logged elsewhere.
  }

  const gate = await getCurrentGate(slug);
  if (!gate) return { error: "Section not configured. Contact admin." };

  const ok = await bcrypt.compare(password, gate.passwordHash);
  if (!ok) return { error: "Wrong password." };

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

  // Cookie marker for middleware.
  const c = await cookies();
  c.set(`gml-gate-${slug}`, "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });

  redirect(next);
}
