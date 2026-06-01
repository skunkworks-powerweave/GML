"use client";

// Spec 122 — bare ⓘ icon that pops the same tooltip as HelpTip.
// Used inside Stat labels, table column headers, and anywhere a phrase can't
// carry its own underline (e.g. compact pill labels).
//
// Reuses HelpTip's hover/tap state machine but renders the wrapper as an
// inline ⓘ circle instead of a dotted-underline span.

import { useEffect, useRef, useState } from "react";
import { helpFor } from "@/lib/help";
import { openHelp } from "./HelpPanel";

type HelpDotProps = {
  /** Dictionary slug. If unknown, the dot renders nothing. */
  k: string;
  /** Optional pixel size of the dot. Defaults to 12px to match prototype line height. */
  size?: number;
  /** Optional aria-label override. Defaults to "What is <title>?". */
  label?: string;
};

export function HelpDot({ k, size = 12, label }: HelpDotProps) {
  const entry = helpFor(k);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!entry) return null;

  return (
    <span
      ref={ref}
      data-help-dot={k}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4 }}
    >
      <button
        type="button"
        aria-label={label ?? `What is ${entry.title}?`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{
          width: size + 2,
          height: size + 2,
          borderRadius: "50%",
          border: "1px solid var(--ink-3)",
          background: "transparent",
          color: "var(--ink-3)",
          padding: 0,
          fontSize: Math.max(8, size - 4),
          fontWeight: 600,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "help",
          fontFamily: "var(--serif)",
        }}
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
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
            color: "var(--ink)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span style={{ display: "block", fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{entry.title}</span>
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
