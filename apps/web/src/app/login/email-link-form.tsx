"use client";

// Magic-link sign-in. Rendered only when AUTH_EMAIL_ENABLED is true -- the
// login page decides, so this component never has to guess whether a relay
// exists. See lib/auth-email.ts.
//
// It used to POST directly to Auth.js's built-in /api/auth/signin/email, which
// is gone; it now goes through a server action so `shouldCreateUser: false`
// is applied server-side where a caller cannot drop it.

import { useActionState } from "react";
import { sendMagicLinkAction, type EmailActionState } from "./email-actions";

export function EmailLinkForm() {
  const [state, formAction, pending] = useActionState<EmailActionState | undefined, FormData>(
    sendMagicLinkAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700" role="status">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <p className="text-xs uppercase tracking-wide text-neutral-500">
        Or sign in with an email link
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span>Email</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="rounded-md border border-neutral-300 px-3 py-2 focus:border-neutral-900 focus:outline-none"
        />
      </label>
      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
