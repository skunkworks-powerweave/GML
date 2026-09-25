"use client";

// Floating ? help button — ports `mobile-shell.jsx`'s help FAB.
//
// IT OPENS THE REAL HELP PANEL. It used to open its own sheet of five
// hardcoded English bullets, while the HelpPanel (spec 122) -- the searchable
// dictionary, and the "Talk to a person" card with WhatsApp, email and an
// in-app helpdesk ticket -- was mounted on every page with no way to reach it
// on a phone: its only trigger was the `?` key, and a phone has no keyboard.
// A locked-out or confused teacher on a handset therefore could not reach the
// helpdesk at all.
//
// Nothing the sheet said was dropped. Its bullets now live in lib/help.ts, in
// the "Getting started" group the panel's browse view lists first: moving
// around (navigation), WhatsApp upload (whatsapp_ingest), direct browser upload
// on stable wifi (upload), confidentiality, and what to do about a forgotten
// password (password) -- the last of which was the only in-app instruction a
// locked-out teacher had, and had no dictionary entry before.
//
// data-help-anchor="topbar-help" makes this the FTUX tour's "Help is always
// here" target on mobile. The desktop top bar carries the same anchor on its
// HelpButton; the two shells never render together, so exactly one element
// matches on any page.

import { openHelp } from "@/components/help/HelpPanel";

/**
 * `label` is the accessible name, translated by the (server) shell like the
 * desktop HelpButton's: it was the literal "Help" in every locale, so a
 * Hindi or Bhoti screen-reader user heard English for the one way into help.
 */
export function MobileHelpFAB({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-help-anchor="topbar-help"
      onClick={() => openHelp(null)}
      style={{
        position: "fixed",
        right: 14,
        bottom: 84,
        width: 44,
        height: 44,
        borderRadius: "50%",
        background: "var(--ink)",
        color: "var(--paper)",
        border: "none",
        boxShadow: "var(--shadow-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 25,
        fontFamily: "var(--serif)",
        fontSize: 20,
        fontWeight: 600,
      }}
    >
      ?
    </button>
  );
}
