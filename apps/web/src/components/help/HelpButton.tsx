"use client";

// The help system's visible entry point in the desktop top bar.
//
// HelpPanel (spec 122) was mounted on every authenticated page with no control
// that opened it: its only trigger was the `?` keyboard shortcut, which nobody
// is told about until the panel is already open, and which does not exist on
// a phone at all. The four components built to open it (HelpTip, HelpDot,
// HelpHeadbtn, useHelpShortcut) had zero call sites. This button, and the
// mobile FAB beside the bottom tabs, are the two ways in.
//
// No state and no hooks: a click dispatches the shared `gml:open-help` event
// that HelpPanel listens for, opening the browse view (topic null).

import { openHelp } from "./HelpPanel";

export function HelpButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => openHelp(null)}
      aria-label={label}
      title={label}
      data-help-open=""
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: "1px solid var(--line)",
        background: "var(--card-hi)",
        color: "var(--ink-2)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--serif)",
        fontSize: 15,
        fontWeight: 600,
        lineHeight: 1,
        padding: 0,
      }}
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}
