"use client";

// Spec 122 — `?` / `Shift+/` / `⌘?` keyboard shortcut to toggle the help panel.
//
// The HelpPanel component already attaches its own keydown listener when it
// mounts, so this hook is the orthogonal entry-point for any page that wants
// to listen for the shortcut without rendering the panel (e.g. an onboarding
// banner that should defer to the panel when the user presses ?).
//
// Returns the canonical `open()` helper. Callers should NOT add their own
// keydown listener — let this hook be the single source of truth so the
// behaviour stays consistent across pages.

import { useEffect } from "react";
import { openHelp } from "./HelpPanel";

export function useHelpShortcut(opts?: { onOpen?: (topic?: string | null) => void }): {
  open: (topic?: string | null) => void;
} {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const isQuestion = e.key === "?" || (e.shiftKey && e.key === "/") || (e.metaKey && e.key === "?");
      if (!isQuestion) return;
      e.preventDefault();
      openHelp(null);
      opts?.onOpen?.(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts]);

  return { open: (topic) => openHelp(topic ?? null) };
}
