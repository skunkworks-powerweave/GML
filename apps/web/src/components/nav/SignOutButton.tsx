"use client";

// Spec 169 — small client island around the Topbar's "Sign out" form button.
//
// The Topbar (server component) renders a <form action={signOut}>; clicking
// the button fires the next-auth server action and the browser navigates to
// /login. Just before the navigation kicks off we want to wipe device-local
// state that belongs to the previous user: the QuickFind recents (spec 121
// stores them in `gml.quickfind.recent.<userId>`), the cycle page's unsent
// observation drafts (sessionStorage, lib/observation/drafts.ts), and the form
// runners' device copies of answers whose save had not landed (localStorage,
// components/forms/draft-resilience.ts). The two draft stores were added after
// this button and were left behind at every sign-out, confidential rubric and
// note text included, on what is often a shared school machine.
//
// We can't put this logic in the server form because client-only APIs
// (window.localStorage) aren't available in a server action; we can't put it
// in QuickFind.tsx itself because that component unmounts AFTER the form
// submission. The right home is here: a 'use client' wrapper that owns the
// onClick handler, runs the synchronous cleanup, then lets the form's native
// submit path proceed unchanged.
//
// Cleanup is synchronous and bounded — a storage scan + removeItem loop over a
// key prefix, and each wipe swallows its own storage failure rather than
// breaking sign-out. The one time we preventDefault is when the user says no:
// a device copy was promised to the user ("Your answers are kept on this
// device"), so it is not discarded unasked, and declining keeps them signed
// in with their answers where they were.

import type { CSSProperties, ReactNode } from "react";
import { clearAllQuickFindRecents } from "@/components/quickfind/QuickFind";
import { clearAllDrafts } from "@/lib/observation/drafts";
import { clearAllLocalCopies, hasLocalCopies } from "@/components/forms/draft-resilience";

type SignOutButtonProps = {
  /** Native button title (tooltip). Localised by caller. */
  title?: string;
  /** Inline style passthrough — caller owns the visual contract. */
  style?: CSSProperties;
  children: ReactNode;
};

const DISCARD_UNSAVED =
  "Some form answers on this device have not been saved yet. Signing out discards them. Sign out anyway?";

/** Yes, unless the user declines; a dialog that cannot open never blocks sign-out. */
function discardConfirmed(): boolean {
  try {
    return typeof window.confirm !== "function" || window.confirm(DISCARD_UNSAVED);
  } catch {
    return true;
  }
}

function clearObservationDrafts(): void {
  try {
    clearAllDrafts(window.sessionStorage);
  } catch {
    // sessionStorage missing or blocked: nothing was kept in it.
  }
}

export function SignOutButton({ title, style, children }: SignOutButtonProps) {
  return (
    <button
      type="submit"
      title={title}
      data-testid="signout-button"
      onClick={(e) => {
        if (hasLocalCopies() && !discardConfirmed()) {
          e.preventDefault();
          return;
        }
        // Spec 169 — wipe QuickFind recents BEFORE the form submit fires.
        // Each wipe is best-effort and never throws; a wipe failure must not
        // block sign-out.
        clearAllQuickFindRecents();
        clearObservationDrafts();
        clearAllLocalCopies();
      }}
      style={style}
    >
      {children}
    </button>
  );
}
