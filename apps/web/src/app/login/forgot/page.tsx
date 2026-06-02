// Spec 161 — /login/forgot page. Standalone form that POSTs the user's email
// to /api/auth/forgot-password and renders a generic "if this email matches
// an account, we sent a link" success state regardless of whether the email
// actually resolved to a user. The no-enumeration contract is enforced at
// the API layer (route.ts always returns 200); this page mirrors it in copy
// so an attacker tabbing through the form can't distinguish a real teacher
// email from a typo by reading the response.
//
// The "Back to login" link sits below the form so a user who tabbed here by
// mistake can return without losing their pre-auth locale cookie (which is
// scoped to `/`, not `/login`, so it survives the navigation).

"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      // Spec 161 — the API is intentionally non-leaky: 200 on success, 200
      // even if the email doesn't resolve to a user. The page therefore
      // shows the same success state for both. A 429 (rate-limit) is the
      // only signal the user can distinguish — we surface that as a
      // generic "try again later" so the failure mode is recoverable
      // without leaking which emails are real.
      if (res.status === 429) {
        setError("Too many requests. Please wait an hour and try again.");
      } else if (!res.ok) {
        setError("Something went wrong. Please try again.");
      } else {
        setSubmitted(true);
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
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
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 12 }}>Check your email</h1>
          <p
            data-testid="forgot-password-success"
            role="status"
            style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}
          >
            If an account exists for that email address, we have sent a password reset link. The link
            expires in 30 minutes.
          </p>
          <Link
            href="/login"
            style={{ display: "inline-block", marginTop: 24, fontSize: 13, color: "var(--ink)" }}
          >
            ← Back to sign in
          </Link>
        </div>
      </div>
    );
  }

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
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 8 }}>Reset your password</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 20, lineHeight: 1.5 }}>
          Enter the email associated with your Goldenmile account and we will send you a one-time link
          to choose a new password.
        </p>
        <form
          onSubmit={onSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
          data-testid="forgot-password-form"
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                padding: "9px 11px",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                background: "var(--card-hi)",
                fontSize: 14,
              }}
            />
          </label>
          {error ? (
            <p style={{ fontSize: 12, color: "var(--rust)" }} role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending || !email}
            className="btn btn-primary"
            style={{
              width: "100%",
              justifyContent: "center",
              padding: "10px 12px",
              fontSize: 14,
              opacity: pending || !email ? 0.6 : 1,
            }}
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </form>
        <Link
          href="/login"
          style={{ display: "inline-block", marginTop: 20, fontSize: 13, color: "var(--ink-2)" }}
        >
          ← Back to sign in
        </Link>
      </div>
    </div>
  );
}
