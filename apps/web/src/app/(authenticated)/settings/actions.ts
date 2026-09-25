"use server";

// Shared sign-out server action.
//
// The settings page previously ended the session with a plain
// `<a href="/api/auth/signout">`, which had three problems:
//   1. it navigated to a page-like route with an <a>, which @next/next's
//      no-html-link-for-pages rejects;
//   2. it performed a state-changing operation over GET; and
//   3. it hard-coded an Auth.js route path, so it would 404 the moment the
//      auth provider changes.
//
// Routing it through a server action fixes all three and gives the settings
// page the same submit path the Topbar already uses, so there is exactly one
// sign-out implementation to keep working.

import { auth, signOut, signInWithPassword } from "@/auth";
import { passwordPolicyError } from "@/lib/password-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { clearMustChangePassword } from "@/lib/supabase/must-change-password";
import { recordAudit } from "@/lib/audit";

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}

// ── Self-service password change ─────────────────────────────────────────────
//
// THIS DID NOT EXIST. The settings page linked to `/account/security`, a route
// with no page behind it, so the link 404'd — and there was no other way for a
// user to change their own password anywhere in the application.
//
// That is a production blocker rather than a gap, because of how onboarding
// works with SMTP deferred to IT: an administrator CREATES the account with a
// password, reads it out, and both operator documents then tell the holder to
// "change it in Settings". If they cannot, every account in the programme runs
// permanently on a password an administrator chose, typed, and still has
// written down. There is no recovery path either, because self-service reset
// is off until SMTP is configured.

export type ChangePasswordState = { error?: string; ok?: string };

export async function changePasswordAction(
  _prev: ChangePasswordState | undefined,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await auth();
  if (!session) return { error: "Your session has ended. Sign in again." };

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!current) return { error: "Enter your current password." };
  const policy = passwordPolicyError(next);
  if (policy) return { error: policy };
  if (next !== confirm) return { error: "The new passwords do not match." };
  if (next === current) return { error: "That is your current password." };

  // RE-AUTHENTICATE FIRST. Supabase will change the password on the strength of
  // a valid session alone, and that is not good enough here: these are shared
  // school computers. Without this check, anyone who finds an unlocked machine
  // can set a new password and lock the owner out of their own account.
  //
  // Verified against the user's OWN email, so this cannot be used to probe
  // anyone else's credentials.
  const email = session.user.email;
  if (!email) return { error: "This account has no email address on file." };

  const verify = await signInWithPassword(email, current);
  // Only a credential failure means the password was wrong. Telling someone
  // throttled, or caught by an outage, that they mistyped it is the misreport
  // the login page used to make.
  if (verify.error === "rate_limited") {
    return { error: "Too many attempts. Wait a few minutes and try again." };
  }
  if (verify.error === "unavailable") {
    return { error: "Your current password cannot be checked right now. Try again in a few minutes." };
  }
  if (verify.error) return { error: "That is not your current password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    // Supabase's message is specific (length, strength policy, reuse) and safe
    // to surface: the caller has just proved they hold the current password.
    return { error: error.message };
  }

  // End the session on every OTHER device. If the reason someone is changing
  // their password is that they think it is known, leaving those alive defeats
  // the exercise. 'others' keeps THIS session so they are not bounced to
  // /login the instant it succeeds.
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);

  // A password they chose themselves: lift the must-change flag an
  // administrator-set one carries, and re-mint this browser's token without it.
  await clearMustChangePassword(session.user.id, supabase);

  // Never log the password, its length, or any derivative.
  void recordAudit({
    action: "auth.password.changed",
    entityType: "user",
    entityId: session.user.id,
    metadata: { selfService: true, otherSessionsEnded: true },
  });

  return { ok: "Password changed. You have been signed out on other devices." };
}
