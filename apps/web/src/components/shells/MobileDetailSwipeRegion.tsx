"use client";

// Spec 139 — Mobile swipe gestures (Workflow Run 12 frontend-parity closure).
//
// Tiny client-component wrapper used inside MobileDetailFrame to attach the
// swipe-right → router.back() gesture. MobileDetailFrame itself remains a
// sync server component (so server-render of pages stays cheap and RSC
// streaming isn't broken); this wrapper is the smallest possible client
// boundary that owns the gesture state.
//
// The wrapper is ADDITIVE — the tap-friendly back arrow at the top of the
// MobileDetailFrame header is still present and primary. Swiping right is a
// shortcut for users with one-handed thumbs; the back arrow is the canonical
// affordance for screen readers and keyboard navigation.

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useSwipe } from "@/lib/use-swipe";

export type MobileDetailSwipeRegionProps = {
  /** Where the back arrow points — used as the fallback when the history stack is empty (e.g. deep link entry). */
  backHref: string;
  children: ReactNode;
};

export function MobileDetailSwipeRegion({ backHref, children }: MobileDetailSwipeRegionProps) {
  const router = useRouter();
  // onSwipeRight → navigate back. We call router.back() so the user keeps
  // their scroll position on the listing page; if there's no history (deep
  // link), we fall back to a push to `backHref`. This matches the back-arrow
  // semantics — they go to the same place.
  const { ref, reducedMotion } = useSwipe<HTMLDivElement>(
    undefined,
    () => {
      // `history.length` of 1 means we landed here as the first page in this
      // tab — no entry to pop. Push the listing instead so a deep link still
      // gets a sensible back.
      if (typeof window !== "undefined" && window.history.length > 1) {
        router.back();
      } else {
        router.push(backHref);
      }
    },
  );
  return (
    <div
      ref={ref}
      data-testid="mobile-detail-swipe-region"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={{
        touchAction: "pan-y", // allow vertical scroll; horizontal is ours to interpret
      }}
    >
      {children}
    </div>
  );
}
