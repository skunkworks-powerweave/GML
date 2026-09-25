"use server";

import { redirect } from "next/navigation";
import { recoverySessionState } from "@/auth";
import { passwordPolicyError } from "@/lib/password-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { clearMustChangePassword } from "@/lib/supabase/must-change-password";

export type ResetState = { error?: string };

/**
 * Set a new password for the user holding a recovery session.
 *
 * THE TOKEN IS NOT A FORM FIELD ANY MORE, and that is the point. The old flow
 * carried a reset token in the URL, put it in a hidden input, and POSTed it to
 * /api/auth/reset-password, which bcrypt-compared it against every unconsumed
 * row in password_reset_tokens -- an unauthenticated, unthrottled, O(N) bcrypt
 * loop. Now the recovery link is exchanged for a real session at
 * /auth/callback, and this action simply asks "who is calling?" and updates
 * that account. There is nothing left to leak in a URL, nothing to replay from
 * a browser history entry, and no per-request bcrypt scan.
 */
export async function resetPasswordAction(
  _prev: ResetState | undefined,
  formData: FormData,
): Promise<ResetState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  // The one policy every password-setting path uses (lib/password-policy.ts).
  const policy = passwordPolicyError(password);
  if (policy) return { error: policy };
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  // A RECOVERY session, not merely a session. No current password is asked
  // for here, which is only sound because following the emailed link proved
  // control of the mailbox; an ordinary signed-in browser proves nothing about
  // who is sitting at it. See recoverySessionState() in auth.ts.
  const recovery = await recoverySessionState();
  if (recovery === "not_recovery") {
    return {
      error: "This page only sets a password from a reset link. To change your password, use Settings.",
    };
  }
  if (recovery !== "recovery") {
    return { error: "This reset link has expired or was already used. Request a new one." };
  }

  const supabase = await createSupabaseServerClient();

  // getUser(), not getClaims(). This is the one place a network round-trip is
  // the correct choice: we are about to change a credential, so the question is
  // not "is this token well-formed" but "does the auth server still consider
  // this session live right now". A locally-verified token that Supabase has
  // since revoked must not be able to set a new password.
  const { data, error: userErr } = await supabase.auth.getUser();
  if (userErr || !data?.user) {
    return {
      error: "This reset link has expired or was already used. Request a new one.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    // Most commonly: the new password matches the old one, or it fails the
    // project's strength policy. Supabase's message is specific and safe to
    // surface -- the caller already holds a live recovery session, so there is
    // no one to leak information to.
    return { error: error.message };
  }

  // Sign out everywhere else. Recovery is what someone does after losing
  // control of an account, so leaving the attacker's other sessions alive would
  // defeat the exercise. 'others' keeps THIS session so the redirect lands on a
  // usable dashboard rather than bouncing back to /login.
  await supabase.auth.signOut({ scope: "others" });

  // They chose this password themselves, so one an administrator set for them
  // no longer needs changing.
  await clearMustChangePassword(data.user.id, supabase);

  redirect("/dashboard");
}
