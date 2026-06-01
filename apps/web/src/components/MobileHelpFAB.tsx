"use client";

// Floating ? help button — ports `mobile-shell.jsx`'s help FAB.
// In v2 the help panel itself (spec 029) is dropped, so this button opens a
// minimal contextual sheet pointing to docs/help.md content. Lightweight, no
// dictionary dependency.

import { useState } from "react";

export function MobileHelpFAB() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Help"
        onClick={() => setOpen(true)}
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

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(28, 24, 22, 0.45)",
            zIndex: 30,
            display: "flex",
            alignItems: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--paper)",
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              width: "100%",
              padding: "18px 18px calc(24px + env(safe-area-inset-bottom, 0))",
              maxHeight: "75dvh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                width: 38,
                height: 4,
                borderRadius: 2,
                background: "var(--line)",
                margin: "0 auto 14px",
              }}
            />
            <h2 style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>How this app works</h2>
            <ul style={{ paddingLeft: 18, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 16 }}>
              <li>Use the bottom tabs to switch between sections.</li>
              <li>Upload classroom videos via WhatsApp to the programme number — they appear in your <strong>My Uploads</strong> tab within a few minutes.</li>
              <li>Direct browser upload also works if you have stable wifi.</li>
              <li>All content is confidential; do not share outside the programme.</li>
              <li>Forgot your password? Ask your programme admin to send a sign-in link.</li>
            </ul>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                width: "100%",
                padding: "10px 14px",
                border: "1px solid var(--ink)",
                background: "var(--ink)",
                color: "var(--paper)",
                borderRadius: "var(--r-2)",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
