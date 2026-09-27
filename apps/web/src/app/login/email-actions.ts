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

import { getTranslations } from "next-intl/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authEmailEnabled, appOrigin } from "@/lib/auth-email";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request-ip";

export type EmailActionState = { ok?: boolean; error?: string; message?: string };

// Deliberately identical for "sent", "no such account" and "rate limited at the
// Supabase end". The endpoint must not answer the question "does this address
// have an account here?" -- for an organisation whose addresses follow a
// predictable pattern, that is a staff roster.
/**
 * The one answer every request gets, sent or not, account or not: anything
 * else tells a caller which addresses have accounts. In the user's language.
 */
async function neutral(): Promise<EmailActionState> {
  const t = await getTranslations("login");
  return { ok: true, message: t("emailLink.sent") };
}

/**
 * Throttle by IP -- the peer Caddy saw, from lib/request-ip. A private copy of
 * the header read used to live here and took the FIRST X-Forwarded-For element,
 * which the client writes: one new header value per request and this limit
 * never fired.
 *
 * Supabase rate-limits its own send endpoint, but that limit is
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
  const t = await getTranslations("login");
  if (!authEmailEnabled()) {
    return { error: t("emailLink.disabled") };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: t("emailLink.enterEmail") };
  if (!(await throttle("magic-link"))) return neutral();

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
  // Result deliberately ignored: see neutral() above.
  return neutral();
}

export async function requestPasswordResetAction(
  _prev: EmailActionState | undefined,
  formData: FormData,
): Promise<EmailActionState> {
  const t = await getTranslations("login");
  if (!authEmailEnabled()) {
    return { error: t("forgot.disabled") };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: t("emailLink.enterEmail") };
  if (!(await throttle("password-reset"))) return neutral();

  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${await appOrigin()}/auth/callback?next=%2Flogin%2Freset`,
  });
  return neutral();
}
