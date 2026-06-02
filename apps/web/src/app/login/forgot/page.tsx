// Spec 161 — /login/forgot page. Server component that reads SMTP_HOST at
// render time, then either:
//   (a) Renders a yellow banner explaining that password reset is
//       unavailable on deployments where SMTP_HOST is unset, or
//   (b) Renders the client-side ForgotPasswordForm that POSTs the email
//       to /api/auth/forgot-password.
//
// Spec 168 (SMTP-aware UX) — the previous version was a single client
// component that rendered the form unconditionally. Operators running
// without an outbound SMTP relay (the LAN-only Ladakh deployment
// scenario) would type their email, see "Check your email", and never
// receive anything because the API silently no-ops the send when no
// transporter is configured. The route still returns 200 regardless of
// whether the email actually fired (no-enumeration contract), but the
// page now surfaces the truth up-front so the user contacts their
// programme admin instead of waiting for an email that will never come.
//
// The /api/auth/forgot-password POST route still returns 200 in BOTH
// branches — the SMTP banner is purely a UX affordance, not a security
// signal. An attacker probing the API directly still gets the same
// no-enumeration shape regardless of whether SMTP_HOST is set.

import Link from "next/link";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  // Spec 168 — read SMTP_HOST at render time on the server. We DON'T
  // expose this value to the client (no NEXT_PUBLIC_ prefix) so an
  // attacker can't enumerate which deployments have SMTP configured by
  // sniffing bundled JS.
  const smtpConfigured =
    typeof process.env.SMTP_HOST === "string" &&
    process.env.SMTP_HOST.trim().length > 0;

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
        {smtpConfigured ? (
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
