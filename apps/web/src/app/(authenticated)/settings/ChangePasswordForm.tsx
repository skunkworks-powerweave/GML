"use client";

// Self-service password change.
//
// Replaces a link to `/account/security` — a route that has never existed, so
// the only affordance for changing your own password in the entire application
// was a 404.

import { useActionState, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { changePasswordAction, type ChangePasswordState } from "./actions";

/** Long enough to read "Password changed", in Hindi or Bhoti too, before the dashboard opens. */
export const CONTINUE_AFTER_MS = 3000;

const goToDashboard = () => window.location.assign("/dashboard");

/**
 * After a REQUIRED change: say it worked and open the dashboard. Until now
 * every page led back to Settings, so leaving the person here made the menu
 * look as dead as before (live QA, 9 Oct 2026).
 *
 * Automatically only on a clean success. When the other devices could not be
 * signed out (`warning`), that sentence is the only place the person learns a
 * session opened with the handed-over password may still be alive, so it stays
 * on screen until they choose to go on. A button goes there at once either way.
 *
 * A full page load, not router.push: the first-run tour, held back on this
 * response (layout.tsx), then plays on the dashboard from a fresh layout.
 */
export function ContinueToDashboard({ message, warning = false }: { message: string; warning?: boolean }) {
  const t = useTranslations("home.client.changePassword");
  useEffect(() => {
    if (warning) return;
    const timer = window.setTimeout(goToDashboard, CONTINUE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [warning]);
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 320 }}>
      <span
        role={warning ? "alert" : "status"}
        data-testid="password-changed-continuing"
        style={{ fontSize: 12, color: warning ? "var(--ink)" : "var(--ok-ink, #047857)" }}
      >
        {warning ? message : `${message} ${t("continuing")}`}
      </span>
      <div>
        <button type="button" className="btn btn-primary" onClick={goToDashboard} autoFocus={warning} data-testid="password-changed-go">
          {t("goToDashboard")}
        </button>
      </div>
    </div>
  );
}

const field: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  background: "var(--card)",
  fontSize: 12,
  width: "100%",
};

export function ChangePasswordForm({ required: requiredBySession = false }: { required?: boolean }) {
  // Someone still on a password an administrator set: the form opens and says
  // why. Settings passes it from the session (auth()), because straight after
  // sign-in the proxy's redirect happens inside a client navigation that can
  // render this page without the ?password=required it carries -- a new user
  // then saw Settings with no reason given and the form closed.
  const required = useSearchParams()?.get("password") === "required" || requiredBySession;
  const t = useTranslations("home.client.changePassword");
  const tAction = useTranslations("action");
  const [open, setOpen] = useState(required);
  const [state, formAction, pending] = useActionState<ChangePasswordState | undefined, FormData>(
    changePasswordAction,
    undefined,
  );

  // From the action's result, not `required`: the action re-mints the token
  // and Next re-renders this page with it in the same response, so the prop
  // reads false by the time state.ok arrives.
  if (state?.ok && state.continueToDashboard) {
    return <ContinueToDashboard message={state.ok} warning={state.othersStillSignedIn === true} />;
  }

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
        {t("open")}
      </button>
    );
  }

  return (
    <form action={formAction} style={{ display: "grid", gap: 6, width: "100%", maxWidth: 320 }}>
      {required ? (
        <p role="status" data-testid="password-change-required" style={{ fontSize: 12, margin: 0 }}>
          {t("required")}
        </p>
      ) : null}
      {/* autoComplete hints so a password manager offers to update the stored
          entry rather than saving a second one. */}
      <input
        name="currentPassword"
        type="password"
        required
        autoComplete="current-password"
        placeholder={t("current")}
        style={field}
      />
      <input
        name="newPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        autoComplete="new-password"
        placeholder={t("new", { min: MIN_PASSWORD_LENGTH })}
        style={field}
      />
      <input
        name="confirmPassword"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        autoComplete="new-password"
        placeholder={t("confirm")}
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
          {pending ? tAction("saving") : t("submit")}
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
          {tAction("cancel")}
        </button>
      </div>

      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
        {t("note")}
      </span>
    </form>
  );
}
