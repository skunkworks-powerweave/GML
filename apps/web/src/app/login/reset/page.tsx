// Spec 161 — /login/reset?token=... page. The user lands here from the
// email link; the page validates the token client-side by POSTing to
// /api/auth/reset-password (which short-circuits if the token is missing
// or already consumed) and then prompts for the new password.
//
// The token validation happens lazily — the page renders the password form
// optimistically and the API responds with the verdict at submit time. We
// don't pre-validate via a GET because that would burn the token's
// once-only-use semantics on a page-load that the user might not complete
// (e.g. accidental click from the email, then close the tab).

"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

const MIN_PASSWORD_LENGTH = 8;

function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This reset link is missing its token. Please request a new link.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.status === 410) {
        setError("This reset link has expired or has already been used. Please request a new one.");
      } else if (res.status === 400) {
        setError("Invalid request — please request a new reset link.");
      } else if (!res.ok) {
        setError("Something went wrong. Please try again.");
      } else {
        router.push("/login?reset=success");
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 12 }}>Invalid reset link</h1>
        <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }} role="alert">
          This page expects a `token` query parameter. Please use the link from the email we sent you.
        </p>
        <Link
          href="/login/forgot"
          style={{ display: "inline-block", marginTop: 20, fontSize: 13, color: "var(--ink)" }}
        >
          Request a new reset link →
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, width: "100%" }}>
      <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginBottom: 8 }}>Choose a new password</h1>
      <p style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 20, lineHeight: 1.5 }}>
        Pick something memorable but hard to guess — at least {MIN_PASSWORD_LENGTH} characters.
      </p>
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
        data-testid="reset-password-form"
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>New password</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              padding: "9px 11px",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              background: "var(--card-hi)",
              fontSize: 14,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>Confirm password</span>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
          disabled={pending || !password || !confirm}
          className="btn btn-primary"
          style={{
            width: "100%",
            justifyContent: "center",
            padding: "10px 12px",
            fontSize: 14,
            opacity: pending || !password || !confirm ? 0.6 : 1,
          }}
        >
          {pending ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
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
      <Suspense fallback={<div>Loading…</div>}>
        <ResetPasswordInner />
      </Suspense>
    </div>
  );
}
