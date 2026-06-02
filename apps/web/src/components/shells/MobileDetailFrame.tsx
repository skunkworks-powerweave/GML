// Spec 137 (Workflow Run 12 — final frontend parity) — MobileDetailFrame.
//
// Server-component-safe wrapper that ports the common chrome from the JSX
// prototype `LMS GML Frontend/mobile-details.jsx` (334 LOC). On mobile, every
// detail page (mentorship, observation, repo school / class / teacher / mentor,
// etc.) shares the same chrome:
//
//   1. A thin (44px) top header with var(--paper-2) bg, a back arrow on the
//      left that links to `backHref`, a truncated title centered, and an
//      optional right-side icon slot for context actions.
//   2. A body that pads inset 16px sides and respects safe-area-inset-top via
//      env() so the header doesn't collide with the iOS notch / Android cutout.
//   3. An optional sticky-save bar at the bottom for forms — fixed position
//      above the BottomTabs (which sit at bottom: 0 with their own
//      safe-area-inset-bottom). The sticky bar adds its own
//      safe-area-inset-bottom so it floats above the home indicator.
//
// Pattern of adoption (per-page):
//
//     const device = await getDeviceType();
//     const body = (<existing JSX>);
//     return device === "mobile" ? (
//       <MobileDetailFrame title="Cycle" backHref="/observation">
//         {body}
//       </MobileDetailFrame>
//     ) : (
//       body
//     );
//
// The desktop layout is unaffected — MobileDetailFrame only renders inside
// MobileShell.
//
// Touch-target compliance: the back-arrow Link is 44x44 (Apple HIG / Material
// Design minimum), with the visual arrow centered inside via flexbox.
//
// This is a sync server component — it imports next/link (RSC-safe) and emits
// no client-only APIs. It composes cleanly inside the MobileShell <main> slot.

import type { ReactNode } from "react";
import Link from "next/link";
import { MobileDetailSwipeRegion } from "./MobileDetailSwipeRegion";

export type MobileDetailFrameProps = {
  /** Page title displayed centered in the header. Truncates to ellipsis if it overflows the available width. */
  title: string;
  /** Where the back arrow links to. Required — a detail page always has a parent listing. */
  backHref: string;
  /** Optional right-side icon slot (e.g. an Edit pencil, a Share icon). Rendered inside a 44x44 touch target. */
  rightAction?: ReactNode;
  /**
   * Optional sticky-save bar rendered fixed at the bottom of the viewport.
   * Use for forms where a primary save action must always be reachable
   * regardless of scroll position. Renders nothing if omitted.
   */
  stickyAction?: ReactNode;
  /** Page body. Renders inside the main container with 16px horizontal padding. */
  children: ReactNode;
};

export function MobileDetailFrame({
  title,
  backHref,
  rightAction,
  stickyAction,
  children,
}: MobileDetailFrameProps) {
  // Spec 139 — wrap the frame in a swipe-region client component so a
  // rightward swipe anywhere on the detail body triggers router.back(). The
  // gesture is ADDITIVE — the back-arrow Link below remains the canonical
  // affordance for keyboard / screen-reader users and is the visible chrome
  // for first-time users who don't yet know about the swipe shortcut.
  return (
    <MobileDetailSwipeRegion backHref={backHref}>
    <div
      data-mobile-detail-frame="true"
      style={{
        // Reserve room at the bottom for the BottomTabs (~ 64px) plus the
        // sticky-action bar (~ 56px) when present, so the page body never
        // hides behind them. We rely on safe-area-inset-bottom on the bars
        // themselves so the home-indicator gap is honored once.
        minHeight: "calc(100dvh - 80px)",
        paddingBottom: stickyAction ? 72 : 0,
      }}
    >
      {/* Thin top header — 44px tall, sticky beneath any outer chrome. */}
      <header
        data-testid="mobile-detail-header"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "grid",
          gridTemplateColumns: "44px 1fr 44px",
          alignItems: "center",
          height: 44,
          background: "var(--paper-2)",
          borderBottom: "1px solid var(--line)",
          paddingTop: "env(safe-area-inset-top, 0)",
        }}
      >
        {/* Back-arrow — Link wrapped in a 44x44 touch target. The arrow
            glyph is centered via flexbox; the outer Link captures the full
            tap area so users with large fingers / gloves can still tap
            reliably. */}
        <Link
          href={backHref}
          aria-label="Back"
          data-testid="mobile-detail-back"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            color: "var(--ink)",
            textDecoration: "none",
            fontSize: 20,
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true">←</span>
        </Link>

        {/* Title — centered, truncates to ellipsis. The font is the chrome
            serif so it matches the desktop page headers. */}
        <h1
          data-testid="mobile-detail-title"
          style={{
            fontFamily: "var(--serif)",
            fontSize: 16,
            fontWeight: 600,
            margin: 0,
            textAlign: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: "var(--ink)",
          }}
          title={title}
        >
          {title}
        </h1>

        {/* Right slot — always rendered as a 44x44 cell so the title stays
            centered visually even when no rightAction is present. */}
        <div
          data-testid="mobile-detail-right"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
          }}
        >
          {rightAction ?? null}
        </div>
      </header>

      {/* Body — 16px horizontal pad. The safe-area-inset-top is consumed by
          the header above, so the body just needs side and bottom space. */}
      <main
        data-testid="mobile-detail-body"
        style={{
          padding: "16px 16px 0",
        }}
      >
        {children}
      </main>

      {/* Optional sticky-save bar — fixed above the BottomTabs (which sit at
          bottom: 0 with their own safe-area-inset-bottom of ~64px). The bar
          adds its own safe-area-inset-bottom so the action button floats
          above the home indicator on iPhones with rounded corners.
          BottomTabs render at bottom: 0 with zIndex 20; we sit at bottom:
          64px with zIndex 19 so we never overlap. */}
      {stickyAction ? (
        <div
          data-testid="mobile-detail-sticky"
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 64,
            zIndex: 19,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 16px",
            paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0))",
            background: "var(--paper-2)",
            borderTop: "1px solid var(--line)",
            boxShadow: "var(--shadow-1)",
          }}
        >
          {stickyAction}
        </div>
      ) : null}
    </div>
    </MobileDetailSwipeRegion>
  );
}
