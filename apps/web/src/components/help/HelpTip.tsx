"use client";

// Spec 122 — dotted-underline word that reveals a tooltip + "Tell me more →"
// link to open the side panel anchored on the same topic.
//
// Ports the prototype's HelpTip (LMS GML Frontend/help.jsx lines 302-347):
//   • hover (desktop) and tap (mobile) show the tooltip;
//   • tooltip title + short come straight from the HELP dictionary;
//   • "Tell me more →" button fires the global `gml:open-help` event and
//     HelpPanel handles the rest;
//   • close-on-outside-click for tap-to-open users (mobile).
//
// Renders an inert <span> wrapping its children. If the slug is unknown the
// tooltip silently degrades to a plain text passthrough so call-sites never
// have to null-check the dictionary.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { helpFor } from "@/lib/help";
import { openHelp } from "./HelpPanel";

type HelpTipProps = {
  /** Dictionary slug. If unknown, children render as plain text. */
  k: string;
  children: ReactNode;
};

export function HelpTip({ k, children }: HelpTipProps) {
  const entry = helpFor(k);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Outside-click closes for tap users.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!entry) return <>{children}</>;

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = setTimeout(() => setOpen(true), 80);
  };
  const hide = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), 80);
  };

  return (
    <span
      ref={ref}
      data-help-tip={k}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
      style={{
        position: "relative",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: 2,
        textDecorationColor: "var(--ink-3)",
        cursor: "help",
      }}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          aria-live="polite"
          data-help-tooltip
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 6px)",
            left: 0,
            width: "min(320px, 90vw)",
            minWidth: 220,
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2, 6px)",
            boxShadow: "var(--shadow-2, 0 8px 20px rgba(28,24,22,0.15))",
            padding: "10px 12px",
            display: "block",
            textAlign: "left",
            color: "var(--ink)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span
            style={{
              display: "block",
              fontWeight: 600,
              fontSize: 12,
              marginBottom: 4,
            }}
          >
            {entry.title}
          </span>
          <span style={{ display: "block", color: "var(--ink-2)" }}>{entry.short}</span>
          {entry.long || (entry.related && entry.related.length > 0) ? (
            <button
              type="button"
              data-help-more
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                openHelp(k);
              }}
              style={{
                marginTop: 8,
                padding: "2px 0",
                border: "none",
                background: "transparent",
                color: "var(--ink)",
                fontSize: 12,
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              Tell me more →
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
