"use client";

import { useActionState } from "react";
import { resetPasswordAction, type ResetState } from "./actions";

const MIN_PASSWORD_LENGTH = 8;

const inputStyle: React.CSSProperties = {
  padding: "9px 11px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2, 8px)",
  background: "var(--card-hi)",
  fontSize: 14,
};

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState<ResetState | undefined, FormData>(
    resetPasswordAction,
    undefined,
  );

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>
          New password
        </span>
        <input
          data-testid="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>
          Confirm password
        </span>
        <input
          data-testid="reset-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          style={inputStyle}
        />
      </label>

      {/* minLength above is a convenience, not the check. The action re-tests
          length and equality server-side, because both attributes are trivially
          removed from the DOM before submitting. */}
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
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
