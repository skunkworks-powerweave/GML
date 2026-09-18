"use client";

// Password-recovery request form.
//
// Spec 168 established the SMTP-aware UX this keeps: tell the user up front
// that email cannot be sent here, rather than accepting their address and
// showing a success message for a message that will never arrive.
//
// Posts to a server action rather than an API route: the old
// POST /api/auth/forgot-password is deleted. What it did was mint a 32-byte
// token, bcrypt-hash it into password_reset_tokens, and mail the plaintext --
// and its sibling /api/auth/reset-password then bcrypt-COMPARED the submitted
// value against every live token row, with no rate limit on the endpoint at
// all. Supabase's recovery flow replaces both.

import { useActionState } from "react";
import { requestPasswordResetAction, type EmailActionState } from "../email-actions";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState<EmailActionState | undefined, FormData>(
    requestPasswordResetAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <p
        role="status"
        data-testid="forgot-sent"
        style={{
          background: "var(--ok-bg, #ecfdf5)",
          color: "var(--ok-ink, #047857)",
          padding: "10px 12px",
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>Email</span>
        <input
          data-testid="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          style={{
            padding: "9px 11px",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2, 8px)",
            background: "var(--card-hi)",
            fontSize: 14,
          }}
        />
      </label>

      {state?.error ? (
        <p role="alert" style={{ color: "var(--danger, #b91c1c)", fontSize: 13 }}>
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        style={{
          padding: "10px 12px",
          borderRadius: "var(--r-2, 8px)",
          border: "none",
          background: "var(--ink)",
          color: "var(--paper)",
          fontSize: 14,
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
