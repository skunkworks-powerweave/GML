// /login/forgot — request a password-reset email.
//
// Spec 168 established the SMTP-aware UX this keeps: tell the user up front
// that email cannot be sent here, rather than accepting their address and
// showing a success message for a message that will never arrive.
//
// Renders one of two things:
//   (a) a banner explaining that resets go through an administrator, or
//   (b) the ForgotPasswordForm, which calls Supabase's recovery flow.
//
// THE FLAG MOVED. This used to read SMTP_HOST from the application's own
// environment. Under Supabase that is the wrong signal entirely -- SMTP is
// configured in the Supabase dashboard, so SMTP_HOST can be unset on a
// deployment where email works perfectly, and set on one where it does not.
// AUTH_EMAIL_ENABLED is the explicit statement of intent instead; see
// lib/auth-email.ts for what IT has to do to turn it on.
//
// The banner is a UX affordance, not a security signal. The underlying action
// returns the same neutral "if that address has an account..." response in both
// branches, so probing it still reveals nothing about who has an account. What
// the banner prevents is a user typing their address, being told to check their
// inbox, and waiting for a message that was never going to arrive.
//
// The value is NOT exposed to the client (no NEXT_PUBLIC_ prefix), so an
// attacker cannot enumerate which deployments have email by reading bundled JS.

import Link from "next/link";
import { authEmailEnabled } from "@/lib/auth-email";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const emailEnabled = authEmailEnabled();

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--paper)",
      }}
    >
      <div style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 8 }}>
          Reset your password
        </h1>
        {emailEnabled ? (
          <ForgotPasswordForm />
        ) : (
          <>
            <div
              role="alert"
              data-testid="forgot-password-smtp-unavailable"
              style={{
                marginTop: 16,
                marginBottom: 20,
                padding: "12px 14px",
                border: "1px solid var(--saffron)",
                background: "var(--saffron-soft)",
                borderRadius: "var(--r-2)",
                fontSize: 13,
                color: "var(--ink-2)",
                lineHeight: 1.5,
              }}
            >
              <strong>Password reset is unavailable on this deployment.</strong>
              <br />
              Contact your programme administrator to have your password reset
              manually.
            </div>
            <Link
              href="/login"
              style={{
                display: "inline-block",
                marginTop: 12,
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              ← Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
