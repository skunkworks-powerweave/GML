"use client";

// Client form for the section-gate page. Receives translated copy as props
// from its server-component parent so the form itself stays free of any
// next-intl runtime dependency — the parent uses `getTranslations()` on the
// server and threads the strings down.
//
// Split out from `page.tsx` (spec 125): the page used to be a client
// component, but now that the gate's copy is i18n-driven it's simpler to do
// the lookup on the server and keep this form purely interactive.

import { useActionState } from "react";
import Link from "next/link";
import { verifyGate, type GateState } from "./actions";

export type GateFormCopy = {
  /** Labels rendered above the form. */
  passwordLabel: string;
  /** "Back" link copy. */
  backLabel: string;
  /** Primary CTA — typically "Unlock section". */
  unlockLabel: string;
  /** Pending-state copy — typically "Checking…". */
  checkingLabel: string;
  /** Lockout footer. */
  footer: string;
};

export function GateForm({
  slug,
  next,
  copy,
}: {
  slug: string;
  next: string;
  copy: GateFormCopy;
}) {
  const [state, formAction, pending] = useActionState<GateState | undefined, FormData>(verifyGate, {});

  return (
    <>
      <form action={formAction} style={{ marginTop: 16 }}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="next" value={next} />
        <div className="form-row">
          <label htmlFor="gate-password">{copy.passwordLabel}</label>
          <input
            id="gate-password"
            className="text"
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="off"
            style={{ fontFamily: "var(--mono)", letterSpacing: "0.1em" }}
          />
          {state?.error ? (
            <div style={{ fontSize: 11, color: "var(--rust)" }} role="alert">{state.error}</div>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 16 }}>
          <Link href="/dashboard" className="btn">← {copy.backLabel}</Link>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? copy.checkingLabel : copy.unlockLabel}
          </button>
        </div>
      </form>

      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: "1px solid var(--line)",
          fontSize: 11,
          color: "var(--ink-3)",
          lineHeight: 1.5,
        }}
      >
        {copy.footer}
      </div>
    </>
  );
}
