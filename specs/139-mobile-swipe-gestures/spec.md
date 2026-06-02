# Spec 139 — Mobile swipe gestures (Workflow Run 12 frontend-parity closure)

## Why

The JSX prototype at `LMS GML Frontend/mobile-details.jsx` describes a
right-swipe-to-go-back gesture as part of the mobile detail-page
contract. Mentors in field tests reported that one-handed thumb
navigation is essential when they're juggling a phone in one hand and
taking notes on a paper observation form with the other. Swiping
right to dismiss the current view is the same gesture iOS and Android
both default to, and matches the prototype's mobile-runners.jsx form
flow where the user expects to flick between question screens
horizontally instead of fishing for the small Next button at the
bottom of the viewport.

Spec 139 ships the swipe affordance as a small, pure-React hook so
the gesture grammar lives in one file, every page that wants it
opts in via the same import, and the test gate pins both the
detection heuristic AND the wiring at the two consumer surfaces
(MobileDetailFrame from spec 137, MobileFormRunner from spec 133).

Swipes are ADDITIVE. The back-arrow on detail pages and the
Previous / Next buttons on the form runner remain primary — a
screen-reader user, a keyboard-only user, or a first-time touch user
who hasn't learned the gesture still has a tap target for every
navigation. The swipe is a thumb-friendly shortcut, never a
replacement.

## What we ship

### 1. `apps/web/src/lib/use-swipe.ts` (CREATED)

Module exports:

- `useSwipe<T>(onSwipeLeft?, onSwipeRight?, options?): { ref, reducedMotion }`
  — the canonical hook. Pass the ref to whichever element should
  detect the gesture.
- `attachSwipe(el, onSwipeLeft?, onSwipeRight?, options?)` —
  imperative variant for callers that already manage a ref.
- `DEFAULT_THRESHOLD_PX = 80` — minimum horizontal travel.
- `DEFAULT_MAX_VERTICAL_PX = 40` — max vertical drift; over this
  the gesture is rejected so vertical scroll wins.
- `DEFAULT_MAX_DURATION_MS = 400` — max gesture duration; slow
  drags are not swipes.

Detection mechanics:

- Pointer events (`pointerdown` / `pointerup` / `pointercancel`)
  — works for touch, mouse, and Playwright pointer-tap fixtures.
- `passive: true` listeners — never calls `preventDefault`, so
  vertical scroll is never hijacked.
- `e.isPrimary` gate — secondary pointers (pinch / multi-touch)
  are ignored so we don't fight zoom gestures.
- `pointerId` match in the up handler — guards against pointer
  capture issues where down and up come from different fingers.

Reduced-motion honour:

- `prefers-reduced-motion: reduce` subscription via `matchMedia`.
- Returned as `reducedMotion: boolean` so the caller can dampen
  its own animation feedback. The gesture itself still fires.

SSR safety:

- All `window` / `document` access is inside `useEffect`. The
  hook can be imported by a server-bundled module without
  exploding.

### 2. `apps/web/src/components/shells/MobileDetailSwipeRegion.tsx` (CREATED)

Tiny `"use client"` wrapper that owns the swipe state for
MobileDetailFrame. Wraps its children in a div with the swipe
ref attached, and wires onSwipeRight to `router.back()` (with a
`router.push(backHref)` fallback when `history.length === 1`,
which is the case for deep-link entries).

The wrapper exists so MobileDetailFrame itself can remain a sync
server component — the minimum client boundary is just this
wrapper.

### 3. `apps/web/src/components/shells/MobileDetailFrame.tsx` (EDITED)

Imports `MobileDetailSwipeRegion` and wraps the entire frame
return value in it. The tap-friendly back arrow at the top of
the header stays exactly as it was — the swipe is layered on
top, never instead of.

### 4. `apps/web/src/components/forms/MobileFormRunner.tsx` (EDITED)

Imports `useSwipe`, calls it at the top of the component body
with `() => goNext()` on left-swipe and `() => goPrev()` on
right-swipe. The left-swipe is gated by `isReview` so a swipe on
the review screen doesn't accidentally submit. Attaches the
returned ref to the outermost `<div>` and sets `touchAction:
"pan-y"` so vertical scroll inside the form body still works.

## Acceptance criteria

- `apps/web/src/lib/use-swipe.ts` exists and exports `useSwipe`,
  `attachSwipe`, plus the three default constants.
- The hook uses pointer events (not raw touch events) so it
  degrades to mouse / trackpad / Playwright cleanly.
- The hook subscribes to `(prefers-reduced-motion: reduce)` and
  returns the boolean to the caller; the gesture still fires
  when reduced motion is on.
- The detection heuristic uses the documented thresholds (80 px
  horizontal, 40 px vertical, 400 ms duration).
- `MobileDetailFrame.tsx` imports and wraps its return in
  `MobileDetailSwipeRegion`.
- `MobileDetailSwipeRegion.tsx` calls `useSwipe(undefined,
  /* onSwipeRight */ ...)` and dispatches to `router.back()` /
  `router.push(backHref)`.
- `MobileFormRunner.tsx` imports and calls `useSwipe` with
  `goNext` and `goPrev`; left-swipe is gated on `!isReview`.
- The outermost `<div>` in MobileFormRunner attaches the ref
  and declares `touchAction: "pan-y"` so vertical scroll is
  preserved.
- All five spec-kit files exist under
  `specs/139-mobile-swipe-gestures/`.
- `tests/governance/test_139_mobile_swipe_gestures.test.mjs`
  passes with at least five assertions covering the above.

## Non-goals

- **No animation library.** No react-spring, react-use-gesture,
  framer-motion. Pure CSS + DOM listeners only — the LMS dep
  graph stays the same.
- **No schema change.** Swipe state is purely client-side; the
  server never knows or cares whether the user tapped or swiped.
- **No replacement of tap affordances.** Every gesture maps to
  an existing button; we never remove a tap target.
- **No vertical-swipe semantics.** Vertical drift is purely a
  rejection mechanism — we never assign meaning to up/down
  swipes (that would conflict with native scroll).
- **No edge-swipe (iOS-style).** The whole frame is the
  detection surface; an edge-only detector would require
  per-page configuration and slow the gesture to learn.
- **No keyboard shortcuts.** Arrow keys + Tab already drive
  navigation on the form runner; swipes are touch-only as a
  matter of policy.
