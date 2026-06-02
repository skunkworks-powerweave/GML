"use client";

// Spec 168 — extracted from the original /login/forgot page so the parent
// page can stay a server component that reads SMTP_HOST at render time.
// The client interactivity (form state, fetch call, success view) lives
// here; the server component (page.tsx) decides whether to render this
// form or the SMTP-unavailable banner.
//
// Behaviour mirrors the original spec 161 contract verbatim:
//   - POST /api/auth/forgot-password with { email: trimmed.toLowerCase() }
//   - Show the same "If an account exists..." success state on 200 (no
//     enumeration — the API returns 200 whether or not the email
//     resolves to a real user).
//   - Surface 429 as a generic "try again later" without leaking which
//     account / IP triggered the rate limit.

import { useState } from "react";
import Link from "next/link";

export function ForgotPasswordForm() {
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
      <div>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, marginBottom: 12 }}>Check your email</h2>
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
    );
  }

  return (
    <>
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
    </>
  );
}
