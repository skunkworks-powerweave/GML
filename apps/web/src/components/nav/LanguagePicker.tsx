"use client";

// LanguagePicker — Topbar client island for the EN / हिन्दी / བོད་ཡིག switcher.
// Spec 155 (Workflow Run 14 audit-closure, MEDIUM).
//
// The shipped Topbar in spec 027 rendered a <details> dropdown with three
// hardcoded list items and no onChange handler; the button label was a static
// "EN". The audit flagged that the picker is visible chrome that lies — clicks
// did nothing and the label never reflected the user's actual locale.
//
// This island POSTs (PUT) to /api/user-prefs (spec 024) with the chosen
// locale, then forces a full document reload so the authenticated layout
// re-reads user_prefs.uiLanguage and the next-intl provider (spec 125) picks
// up the new messages bundle on the next paint. We deliberately reload the
// document rather than relying on router.refresh() because the
// NextIntlClientProvider tree is rooted at the layout — the messages bundle
// and the <html lang> attribute both live above any router-mutable subtree.
//
// Failure modes are surfaced through a small inline status row instead of a
// toast (we don't want a new dependency just to surface a 400/500); the row
// auto-clears on the next picker open so it never blocks a retry.

import { useCallback, useEffect, useRef, useState } from "react";

/** Locale enum mirrors `@/i18n/config::SUPPORTED_LOCALES`. */
export type LocaleCode = "en" | "hi" | "bo";

/** Display labels (native script for non-English so the user can identify their language). */
const LABELS: Record<LocaleCode, { native: string; chip: string }> = {
  en: { native: "English", chip: "EN" },
  hi: { native: "हिन्दी", chip: "हि" },
  bo: { native: "བོད་ཡིག", chip: "བོ" },
};

const ORDER: ReadonlyArray<LocaleCode> = ["en", "hi", "bo"];

type Props = {
  /** Current locale (read from user_prefs.uiLanguage in the parent server component). */
  current: LocaleCode;
  /** Optional translated label for the picker (rendered as sr-only text). */
  ariaLabel?: string;
};

export default function LanguagePicker({ current, ariaLabel = "Language" }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<LocaleCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  // Close on outside click — <details> handles its own toggle but won't close
  // when the user clicks elsewhere; without this the dropdown lingers and
  // overlaps the bell icon.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!detailsRef.current) return;
      if (!detailsRef.current.contains(e.target as Node)) {
        detailsRef.current.removeAttribute("open");
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onPick = useCallback(
    async (next: LocaleCode) => {
      // Clicking the already-selected locale is a no-op — saves a needless
      // round-trip and a full-page reload.
      if (next === current) {
        detailsRef.current?.removeAttribute("open");
        setOpen(false);
        return;
      }
      setPending(next);
      setError(null);
      try {
        const res = await fetch("/api/user-prefs", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uiLanguage: next }),
        });
        if (!res.ok) {
          setError("Couldn't save language preference. Try again.");
          setPending(null);
          return;
        }
        // Force a full reload so the authenticated layout re-reads
        // user_prefs.uiLanguage and the NextIntlClientProvider re-mounts
        // with the new messages bundle. router.refresh() is not enough —
        // the provider sits ABOVE every routable subtree.
        window.location.reload();
      } catch {
        setError("Network error — language not saved.");
        setPending(null);
      }
    },
    [current],
  );

  const summaryChip = LABELS[current].chip;

  return (
    <details
      ref={detailsRef}
      data-testid="topbar-language-picker"
      data-current-locale={current}
      style={{ position: "relative" }}
      onToggle={(e) => {
        const el = e.currentTarget as HTMLDetailsElement;
        setOpen(el.open);
        if (el.open) setError(null);
      }}
    >
      <summary
        aria-label={ariaLabel}
        style={{
          listStyle: "none",
          cursor: pending ? "progress" : "pointer",
          padding: "6px 8px",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2)",
          fontSize: 12,
          color: "var(--ink-2)",
          background: "var(--card-hi)",
        }}
      >
        {pending ? "…" : summaryChip}
      </summary>
      <ul
        style={{
          position: "absolute",
          right: 0,
          top: "calc(100% + 4px)",
          listStyle: "none",
          margin: 0,
          padding: 4,
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2)",
          boxShadow: "var(--shadow-2)",
          minWidth: 160,
          zIndex: 20,
        }}
      >
        {ORDER.map((code) => {
          const isCurrent = code === current;
          const label = LABELS[code].native;
          return (
            <li key={code} style={{ margin: 0 }}>
              <button
                type="button"
                onClick={() => onPick(code)}
                disabled={pending !== null}
                data-locale-option={code}
                aria-pressed={isCurrent}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  border: "none",
                  background: isCurrent ? "var(--paper-2)" : "transparent",
                  color: "var(--ink)",
                  fontSize: 12,
                  fontFamily: code === "hi" ? "var(--deva)" : undefined,
                  textAlign: "left",
                  cursor: pending !== null ? "progress" : "pointer",
                  borderRadius: "var(--r-1)",
                }}
              >
                <span>{label}</span>
                {isCurrent ? (
                  <span aria-hidden style={{ color: "var(--ink-3)", fontSize: 10 }}>•</span>
                ) : null}
              </button>
            </li>
          );
        })}
        {error ? (
          <li
            role="alert"
            data-testid="topbar-language-picker-error"
            style={{
              padding: "6px 10px",
              fontSize: 11,
              color: "var(--rust)",
              borderTop: "1px solid var(--line)",
              marginTop: 4,
            }}
          >
            {error}
          </li>
        ) : null}
      </ul>
    </details>
  );
}
