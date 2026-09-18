"use server";

// Email-based authentication actions: magic-link sign-in and password recovery.
//
// Both are gated on authEmailEnabled() (see lib/auth-email.ts) because SMTP is
// configured in Supabase, not here, and pretending to send mail that cannot
// leave the building is worse than saying so.
//
// WHAT THESE REPLACED. The old /api/auth/forgot-password minted a 32-byte token,
// bcrypt-hashed it into password_reset_tokens, and /api/auth/reset-password
// then bcrypt-compared the submitted plaintext against EVERY live token row --
// an O(N) bcrypt scan on an endpoint with no rate limit at all, which is a CPU
// exhaustion primitive available to any anonymous caller. Both routes are
// deleted; Supabase's recovery flow does this properly and is rate-limited
// centrally.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authEmailEnabled, appOrigin } from "@/lib/auth-email";
import { rateLimit } from "@/lib/rate-limit";
import { headers } from "next/headers";

export type EmailActionState = { ok?: boolean; error?: string; message?: string };

// Deliberately identical for "sent", "no such account" and "rate limited at the
// Supabase end". The endpoint must not answer the question "does this address
// have an account here?" -- for an organisation whose addresses follow a
// predictable pattern, that is a staff roster.
const NEUTRAL =
  "If that address has an account, a message is on its way. Check your inbox, including spam.";

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Throttle by IP. Supabase rate-limits its own send endpoint, but that limit is
 * per-project: without a local limit, one caller looping addresses burns the
 * whole deployment's hourly send quota and denies email to everyone else.
 *
 * Fails CLOSED. If the limiter itself errors we refuse rather than allow --
 * the failure mode this protects against is precisely the one an attacker
 * would try to induce.
 */
async function throttle(bucket: string): Promise<boolean> {
  try {
    const rl = await rateLimit({
      bucket,
      id: await clientIp(),
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    return rl.ok;
  } catch {
    return false;
  }
}

export async function sendMagicLinkAction(
  _prev: EmailActionState | undefined,
  formData: FormData,
): Promise<EmailActionState> {
  if (!authEmailEnabled()) {
    return { error: "Email sign-in is not enabled on this deployment. Use your password." };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter your email address." };
  if (!(await throttle("magic-link"))) return { ok: true, message: NEUTRAL };

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signInWithOtp({
    email,
    options: {
      // THE IMPORTANT LINE. Without it, requesting a link for an unknown
      // address CREATES that account -- which is exactly how the old Auth.js
      // Nodemailer provider let anyone on the internet mint themselves a
      // user row. The access-token hook would refuse the resulting account a
      // token anyway, but there is no reason to let a stranger write a row.
      shouldCreateUser: false,
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=%2Fdashboard`,
    },
  });
  // Result deliberately ignored: see NEUTRAL above.
  return { ok: true, message: NEUTRAL };
}

export async function requestPasswordResetAction(
  _prev: EmailActionState | undefined,
  formData: FormData,
): Promise<EmailActionState> {
  if (!authEmailEnabled()) {
    return {
      error:
        "Password resets are handled by your administrator on this deployment. Contact them to have your password set.",
    };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter your email address." };
  if (!(await throttle("password-reset"))) return { ok: true, message: NEUTRAL };

  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${await appOrigin()}/auth/callback?next=%2Flogin%2Freset`,
  });
  return { ok: true, message: NEUTRAL };
}
