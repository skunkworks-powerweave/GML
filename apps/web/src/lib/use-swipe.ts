"use client";

// Spec 139 — Mobile swipe gestures (Workflow Run 12 frontend-parity closure).
//
// `useSwipe(onSwipeLeft?, onSwipeRight?, options?)` — a vanilla React hook that
// listens to pointerdown / pointermove / pointerup on a target element and
// invokes the supplied callbacks when the gesture meets the heuristic:
//
//   - Horizontal travel ≥ DEFAULT_THRESHOLD_PX (80px by default).
//   - Vertical drift ≤ DEFAULT_MAX_VERTICAL_PX (40px) — so a vertical scroll is
//     never hijacked as a horizontal swipe.
//   - Total gesture duration ≤ DEFAULT_MAX_DURATION_MS (400ms) — a slow drag
//     of the page must not register as a swipe.
//
// We use `pointer*` events (not `touch*`) so the gesture also fires from a
// trackpad / mouse drag during e2e / Playwright tests. Pointer events are
// supported in every browser the LMS targets (Safari 13+, Chrome 55+,
// Firefox 59+, Edge 12+). The hook still degrades cleanly when the user
// agent has no PointerEvent (very old WebViews) — in that case it just no-ops.
//
// Swipes are intentionally ADDITIVE — every page that wires this hook still
// renders its tap targets (back arrow on detail pages, Previous / Next on the
// form runner). The hook never replaces an existing affordance; it just gives
// a thumb-friendly shortcut to the same destination. This is critical for
// accessibility — screen-reader users never receive touch events, so the tap
// affordance is their primary path.
//
// `prefers-reduced-motion` honour — when set, the hook still fires the
// callbacks (the gesture is functional, not decorative) but skips the
// CSS-driven visual feedback (caller can read `useSwipe.reducedMotion` if
// it wants to dampen its own animations). We don't smuggle animation state
// into the hook itself — the gesture detection is the contract.
//
// SSR-safe — the hook references `window` / `document` only inside the
// `useEffect`, so it can be imported into a server bundle without exploding.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const DEFAULT_THRESHOLD_PX = 80;
export const DEFAULT_MAX_VERTICAL_PX = 40;
export const DEFAULT_MAX_DURATION_MS = 400;

export type SwipeOptions = {
  /** Minimum horizontal travel (px) before a swipe is recognised. */
  threshold?: number;
  /** Max vertical drift (px) tolerated before the gesture is rejected. */
  maxVertical?: number;
  /** Max gesture duration (ms) — slower drags are not swipes. */
  maxDuration?: number;
  /** Disable the hook entirely (e.g. when a modal is open on top). */
  disabled?: boolean;
};

export type UseSwipeReturn<T extends HTMLElement> = {
  /** Attach this ref to the element you want to detect swipes on. */
  ref: RefObject<T | null>;
  /**
   * `true` when the user's OS has `prefers-reduced-motion: reduce` set. The
   * gesture itself is unaffected — animation feedback should be dampened.
   */
  reducedMotion: boolean;
};

/**
 * Returns a ref to attach to a swipe-target element. `onSwipeLeft` fires when
 * the user swipes the element rightward across to leftward (i.e. "next");
 * `onSwipeRight` fires the inverse direction (i.e. "back" / "previous").
 *
 * Both callbacks are optional — pass undefined if you only care about one
 * direction. Listeners are cleaned up on unmount.
 */
export function useSwipe<T extends HTMLElement = HTMLDivElement>(
  onSwipeLeft?: () => void,
  onSwipeRight?: () => void,
  options?: SwipeOptions,
): UseSwipeReturn<T> {
  const ref = useRef<T>(null);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);

  // Keep latest callbacks in refs so the effect doesn't re-attach on every
  // render — re-binding listeners every render would defeat the cleanup story
  // and risk dropping in-flight gestures.
  const leftRef = useRef(onSwipeLeft);
  const rightRef = useRef(onSwipeRight);
  // Assigned in an effect, never in the render body. Writing to a ref during
  // render is a render-phase side effect (react-hooks/refs) and is unsafe
  // under StrictMode's double render and concurrent features. No dep array
  // means this runs after every commit, preserving the "always latest"
  // contract. Safe because both refs are read only from the pointer listeners below.
  useEffect(() => {
    leftRef.current = onSwipeLeft;
    rightRef.current = onSwipeRight;
  });

  const threshold = options?.threshold ?? DEFAULT_THRESHOLD_PX;
  const maxVertical = options?.maxVertical ?? DEFAULT_MAX_VERTICAL_PX;
  const maxDuration = options?.maxDuration ?? DEFAULT_MAX_DURATION_MS;
  const disabled = options?.disabled === true;

  // ---- prefers-reduced-motion subscription ----
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(mql.matches);
    apply();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
  }, []);

  // ---- Gesture detection ----
  useEffect(() => {
    if (disabled) return;
    if (typeof window === "undefined") return;
    const el = ref.current;
    if (!el) return;
    // Browsers without PointerEvent (very old) — the hook is a no-op there.
    if (typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
      return;
    }

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let active = false;
    let pointerId: number | null = null;

    const onPointerDown = (e: PointerEvent) => {
      // Only primary pointer — ignore secondary touches that arrive during a
      // pinch / two-finger gesture so we never compete with a scroll.
      if (!e.isPrimary) return;
      active = true;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startT = (e.timeStamp ?? performance.now());
    };

    const onPointerMove = (_e: PointerEvent) => {
      // No-op — we only sample at pointerup. Sampling during the drag would
      // require live tracking + cancellation, which we don't need for the
      // simple "next / previous" gesture grammar.
    };

    const finish = (e: PointerEvent) => {
      if (!active) return;
      if (pointerId !== null && e.pointerId !== pointerId) return;
      active = false;
      pointerId = null;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = (e.timeStamp ?? performance.now()) - startT;
      // Reject slow drags, vertical drift, or below-threshold flicks.
      if (dt > maxDuration) return;
      if (Math.abs(dy) > maxVertical) return;
      if (Math.abs(dx) < threshold) return;
      if (dx < 0) {
        leftRef.current?.();
      } else {
        rightRef.current?.();
      }
    };

    const onPointerCancel = (_e: PointerEvent) => {
      active = false;
      pointerId = null;
    };

    // `passive: true` — we never call preventDefault; the browser is free to
    // scroll normally during the gesture. The vertical-drift rejection above
    // is what keeps a scroll from being misread as a swipe.
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("pointermove", onPointerMove, { passive: true });
    el.addEventListener("pointerup", finish, { passive: true });
    el.addEventListener("pointercancel", onPointerCancel, { passive: true });

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [disabled, threshold, maxVertical, maxDuration]);

  return { ref, reducedMotion };
}

/**
 * Lightweight imperative variant used by callers that already manage their
 * own ref (rare — most callers should reach for `useSwipe`). Returns the
 * detach function. Exported so the governance test can assert the public
 * surface.
 */
export function attachSwipe(
  el: HTMLElement,
  onSwipeLeft?: () => void,
  onSwipeRight?: () => void,
  options?: SwipeOptions,
): () => void {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD_PX;
  const maxVertical = options?.maxVertical ?? DEFAULT_MAX_VERTICAL_PX;
  const maxDuration = options?.maxDuration ?? DEFAULT_MAX_DURATION_MS;

  let startX = 0;
  let startY = 0;
  let startT = 0;
  let active = false;
  let pointerId: number | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    active = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = e.timeStamp ?? performance.now();
  };
  const finish = (e: PointerEvent) => {
    if (!active) return;
    if (pointerId !== null && e.pointerId !== pointerId) return;
    active = false;
    pointerId = null;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = (e.timeStamp ?? performance.now()) - startT;
    if (dt > maxDuration) return;
    if (Math.abs(dy) > maxVertical) return;
    if (Math.abs(dx) < threshold) return;
    if (dx < 0) onSwipeLeft?.();
    else onSwipeRight?.();
  };
  const cancel = () => {
    active = false;
    pointerId = null;
  };

  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  el.addEventListener("pointerup", finish, { passive: true });
  el.addEventListener("pointercancel", cancel, { passive: true });

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointerup", finish);
    el.removeEventListener("pointercancel", cancel);
  };
}
