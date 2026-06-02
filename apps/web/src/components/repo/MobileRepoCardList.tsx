// Spec 138 — Mobile card-list renderer for repository index pages.
//
// On desktop the /repo/<entity> index pages render an 8+ column <table className="t">.
// On a 360px phone that table overflows horizontally and reads poorly. The
// JSX prototype at `LMS GML Frontend/mobile-repo.jsx` (lines 117-142) ships a
// card/row pattern in its place — primary title in serif, 1-3 secondary
// lines in var(--ink-3), optional chip badge top-right, optional Hindi name
// under the title in var(--deva), full card tap-target → entity detail.
//
// This component is presentational only. Each repo index page picks its own
// fields and href factory and renders <MobileRepoCardList items={rows} ... />
// inside a `device === "mobile"` branch (the desktop table stays put). Filters
// continue to drive URL search params the same way (spec 129) — the card-list
// shows whatever the server returns, no extra state.
//
// Touch targets are minimum 64×44 (Apple HIG / Material) — the whole card is
// the link. Safe-area-inset-* is handled by the page chrome shell; cards sit
// in normal flow inside `.page-body`. No client JS is needed for the tap
// target (Link covers everything), so the component is a plain server
// component — Next.js will inline it into the page's SSR pass.

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

/**
 * A single field rendered as a secondary line. `value` is the already-formatted
 * string (callers do their own formatting so this component stays presentational).
 * `mono` flips the font to var(--mono) for things like dates / school codes.
 */
export type MobileRepoSecondaryField = {
  label?: string;
  value: ReactNode;
  mono?: boolean;
};

/**
 * Chip shown in the top-right of the card. `kind` is one of the chip utility
 * classes (chip-indigo, chip-saffron, chip-lichen, chip-rust, etc) — empty
 * string falls back to the default `.chip` palette.
 */
export type MobileRepoChip = {
  label: string;
  kind?: string;
};

export type MobileRepoCardItem = {
  id: string | number;
  /** Card title — the serif 16px line. */
  primary: ReactNode;
  /** Optional Devanagari subtitle below the title (var(--deva)). */
  hindi?: string | null;
  /** 1-3 detail rows shown beneath the title. */
  secondary?: MobileRepoSecondaryField[];
  /** Optional pill badge top-right (status / kind / district). */
  chip?: MobileRepoChip | null;
  /** Where tapping the card navigates. */
  href: string;
  /** aria-label override (defaults to "Open <primary>"). */
  ariaLabel?: string;
};

export type MobileRepoCardListProps = {
  /** Pre-shaped items — caller picks fields per entity. */
  items: MobileRepoCardItem[];
  /** Rendered when items.length === 0; falls back to a sensible default. */
  emptyMessage?: string;
  /** Optional test-id suffix for the wrapping list (`mobile-repo-cards-<id>`). */
  testIdSuffix?: string;
};

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const cardStyle: CSSProperties = {
  background: "var(--card-hi)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-3)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  color: "var(--ink)",
  textDecoration: "none",
  // 44×44 minimum touch target per Apple HIG / Material — the whole card
  // is the link so this floor matters for short rows (mentors index with
  // a missing chip can render at ~52px otherwise).
  minHeight: 44,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--serif)",
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.25,
  color: "var(--ink)",
  // The serif at 16px renders slightly tight against the secondary
  // 12px lines; a small inline-block lets long names wrap cleanly.
  display: "inline-block",
};

const hindiStyle: CSSProperties = {
  fontFamily: "var(--deva)",
  fontSize: 13,
  color: "var(--ink-3)",
  marginTop: 2,
};

const secondaryRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const secondaryLineBaseStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--ink-3)",
  lineHeight: 1.4,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--ink-4)",
  marginRight: 6,
  fontWeight: 500,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  background: "var(--card-hi)",
  border: "1px dashed var(--line)",
  borderRadius: "var(--r-3)",
  color: "var(--ink-3)",
  fontSize: 13,
  textAlign: "center",
};

function renderSecondary(field: MobileRepoSecondaryField, idx: number) {
  const style: CSSProperties = {
    ...secondaryLineBaseStyle,
    fontFamily: field.mono ? "var(--mono)" : undefined,
  };
  return (
    <div key={idx} style={style}>
      {field.label ? <span style={labelStyle}>{field.label}</span> : null}
      {field.value}
    </div>
  );
}

export function MobileRepoCardList({
  items,
  emptyMessage,
  testIdSuffix,
}: MobileRepoCardListProps) {
  if (items.length === 0) {
    return (
      <div
        data-testid={testIdSuffix ? `mobile-repo-cards-empty-${testIdSuffix}` : "mobile-repo-cards-empty"}
        style={emptyStyle}
      >
        {emptyMessage ?? "Nothing here yet."}
      </div>
    );
  }

  return (
    <div
      data-testid={testIdSuffix ? `mobile-repo-cards-${testIdSuffix}` : "mobile-repo-cards"}
      style={wrapperStyle}
    >
      {items.map((it) => {
        const aria =
          it.ariaLabel ??
          (typeof it.primary === "string" ? `Open ${it.primary}` : undefined);
        return (
          <Link
            key={String(it.id)}
            href={it.href}
            style={cardStyle}
            aria-label={aria}
            data-testid="mobile-repo-card"
          >
            <div style={headerStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={titleStyle}>{it.primary}</div>
                {it.hindi ? (
                  <div className="deva" style={hindiStyle}>
                    {it.hindi}
                  </div>
                ) : null}
              </div>
              {it.chip ? (
                <span
                  className={`chip ${it.chip.kind ?? ""}`.trim()}
                  style={{ flexShrink: 0 }}
                >
                  {it.chip.label}
                </span>
              ) : null}
            </div>
            {it.secondary && it.secondary.length > 0 ? (
              <div style={secondaryRowStyle}>
                {it.secondary.slice(0, 3).map((f, idx) => renderSecondary(f, idx))}
              </div>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
