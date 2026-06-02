# Tasks 139

- [x] T1 → write the governance test (red) covering: hook exports
  `useSwipe`, `attachSwipe`, three default constants; the hook
  uses pointer events; subscribes to
  `(prefers-reduced-motion: reduce)`; rejects vertical drift via
  the documented threshold check; MobileDetailFrame imports
  MobileDetailSwipeRegion and wraps its return; the swipe region
  calls router.back() with a backHref fallback; MobileFormRunner
  imports `useSwipe` and wires it to goNext/goPrev with the
  isReview guard; the outermost div carries the swipe ref and
  `touchAction: "pan-y"`. Run suite → red.
- [x] T2 → create `apps/web/src/lib/use-swipe.ts`: hook + imperative
  variant, pointer events, threshold defaults, SSR-safe guard
  (`typeof window === "undefined"`), pointer-event capability
  check (very-old WebView no-op), passive listeners,
  reduced-motion matchMedia subscription.
- [x] T3 → create
  `apps/web/src/components/shells/MobileDetailSwipeRegion.tsx`:
  `"use client"`, accepts `{ backHref, children }`, uses
  `useRouter()` from next/navigation, wires right-swipe to
  `router.back()` with the `history.length === 1` deep-link
  fallback via `router.push(backHref)`, sets
  `touchAction: "pan-y"` on the wrapper div.
- [x] T4 → edit
  `apps/web/src/components/shells/MobileDetailFrame.tsx`: import
  MobileDetailSwipeRegion, wrap the entire frame return in it,
  keep the back-arrow Link unchanged (additive gesture).
- [x] T5 → edit
  `apps/web/src/components/forms/MobileFormRunner.tsx`: import
  useSwipe, call it with `() => goNext()` (gated by `!isReview`)
  and `() => goPrev()`, attach the returned ref to the outermost
  div, declare `touchAction: "pan-y"`, expose
  `data-reduced-motion` for downstream animation throttling.
- [x] T6 → author all five spec-kit files under
  `specs/139-mobile-swipe-gestures/`.
- [x] T7 → run the scoped governance suite
  (`pnpm test -- --test-name-pattern "spec 139"`) → green. Run
  the full suite to confirm no regression — the additions are
  inside an isolated hook + a new wrapper component, no existing
  test touches either surface.
- [ ] T8 (future) → CSS-driven slide-in / slide-out feedback on
  the swipe destination page (with `data-reduced-motion` short-
  circuit). Out of scope here — we ship the gesture; the visual
  polish is a follow-up if mentors ask for it.
- [ ] T9 (future) → swipe on the mobile bottom tabs to switch
  between tabs (left = previous tab, right = next tab). Out of
  scope; BottomTabs is already keyboard-navigable so the
  productivity win is smaller than for the detail / form
  surfaces.
- [ ] T10 (future) → edge-swipe-only mode (iOS-style) toggleable
  via an admin setting. Out of scope; the whole-frame swipe is
  the default and is what the JSX prototype documents.
