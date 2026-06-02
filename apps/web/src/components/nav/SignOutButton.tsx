"use client";

// Spec 169 — small client island around the Topbar's "Sign out" form button.
//
// The Topbar (server component) renders a <form action={signOut}>; clicking
// the button fires the next-auth server action and the browser navigates to
// /login. Just before the navigation kicks off we want to wipe device-local
// state that belongs to the previous user — most importantly the QuickFind
// recents (spec 121 stores them in `gml.quickfind.recent.<userId>`).
//
// We can't put this logic in the server form because client-only APIs
// (window.localStorage) aren't available in a server action; we can't put it
// in QuickFind.tsx itself because that component unmounts AFTER the form
// submission. The right home is here: a 'use client' wrapper that owns the
// onClick handler, runs the synchronous cleanup, then lets the form's native
// submit path proceed unchanged.
//
// Cleanup is synchronous and bounded — localStorage scan + removeItem loop
// over a key prefix. We do NOT preventDefault: the form submit MUST run, so
// any failure inside the cleanup is swallowed (`try/catch` in
// clearAllQuickFindRecents) rather than allowed to break sign-out.

import type { CSSProperties, ReactNode } from "react";
import { clearAllQuickFindRecents } from "@/components/quickfind/QuickFind";

type SignOutButtonProps = {
  /** Native button title (tooltip). Localised by caller. */
  title?: string;
  /** Inline style passthrough — caller owns the visual contract. */
  style?: CSSProperties;
  children: ReactNode;
};

export function SignOutButton({ title, style, children }: SignOutButtonProps) {
  return (
    <button
      type="submit"
      title={title}
      data-testid="signout-button"
      onClick={() => {
        // Spec 169 — wipe QuickFind recents BEFORE the form submit fires.
        // The function is best-effort and never throws (see implementation
        // in QuickFind.tsx); a wipe failure must not block sign-out.
        clearAllQuickFindRecents();
      }}
      style={style}
    >
      {children}
    </button>
  );
}
