"use client";

// Self-service password change.
//
// Replaces a link to `/account/security` — a route that has never existed, so
// the only affordance for changing your own password in the entire application
// was a 404.

import { useActionState, useState } from "react";
import { changePasswordAction, type ChangePasswordState } from "./actions";

const field: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  background: "var(--card)",
  fontSize: 12,
  width: "100%",
};

export function ChangePasswordForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ChangePasswordState | undefined, FormData>(
    changePasswordAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <span role="status" style={{ fontSize: 12, color: "var(--ok-ink, #047857)" }}>
        {state.ok}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="change-password-open"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--indigo)",
          fontSize: 12,
          cursor: "pointer",
          textDecoration: "none",
        }}
      >
        Change password →
      </button>
    );
  }

  return (
    <form action={formAction} style={{ display: "grid", gap: 6, width: "100%", maxWidth: 320 }}>
      {/* autoComplete hints so a password manager offers to update the stored
          entry rather than saving a second one. */}
      <input
        name="currentPassword"
        type="password"
        required
        autoComplete="current-password"
        placeholder="Current password"
        style={field}
      />
      <input
        name="newPassword"
        type="password"
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="New password (8+ characters)"
        style={field}
      />
      <input
        name="confirmPassword"
        type="password"
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Confirm new password"
        style={field}
      />

      {/* minLength above is a convenience. The action re-checks length, the
          match, and the current password server-side — all three attributes are
          removable from the DOM before submitting. */}
      {state?.error ? (
        <span role="alert" style={{ fontSize: 11, color: "var(--danger, #b91c1c)" }}>
          {state.error}
        </span>
      ) : null}

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: "6px 12px",
            border: "none",
            borderRadius: 6,
            background: "var(--ink)",
            color: "var(--paper)",
            fontSize: 12,
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : "Change password"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            padding: "6px 10px",
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            background: "var(--card)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>

      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
        This signs you out on other devices.
      </span>
    </form>
  );
}
