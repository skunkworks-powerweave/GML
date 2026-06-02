# Research 139

Five design choices documented inline in the touched files.

## (1) Pointer events vs raw touch events

The hook uses `pointerdown / pointermove / pointerup / pointercancel`
instead of `touchstart / touchmove / touchend`. Reasons:

- **Test ergonomics** — Playwright's `page.touchscreen.tap()` and
  trackpad / mouse drags in dev all fire as pointer events; touch
  events don't fire for mouse. A pointer-based hook means the same
  gesture is exercised by the same code path in tests and in
  production, with no special "touch-only" branch.
- **Multi-input support** — A field officer with a Bluetooth keyboard
  + trackpad attached to their phone still gets the gesture; raw
  touch events would silently fail there.
- **Modern browser support** — Pointer events are in every browser the
  LMS targets (Safari 13+, Chrome 55+, Firefox 59+). We guard with a
  `typeof window.PointerEvent === "undefined"` early-return so the
  hook degrades to a no-op in very old WebViews (without affecting
  the tap affordances which still work).

## (2) Why we don't `preventDefault` during the gesture

Listeners are registered with `{ passive: true }`. We never call
`preventDefault()`. Vertical scroll is governed by the
`touchAction: "pan-y"` CSS declaration on the swipe-region div — the
browser handles vertical scroll natively, we just observe horizontal
travel. The `Math.abs(dy) > maxVertical` rejection ensures we don't
fire `onSwipe*` while the user is mid-scroll.

This matters for performance: passive listeners don't block the
compositor thread, so scroll stays at 60 fps even on low-end Android
devices common in the Ladakh field.

## (3) Threshold tuning — 80 / 40 / 400

The three constants (`DEFAULT_THRESHOLD_PX = 80`,
`DEFAULT_MAX_VERTICAL_PX = 40`, `DEFAULT_MAX_DURATION_MS = 400`) come
from the Apple HIG and Material Design guidelines:

- **80 px horizontal** — wide enough that an accidental thumb wobble
  during a tap (typically 8-15 px) doesn't trigger; small enough that
  a deliberate flick across the lower half of a 360 px-wide phone
  screen still registers.
- **40 px vertical drift** — vertical scroll routinely produces 200+
  px of vertical travel; the 40-px cap means anything that looks like
  scroll wins. The asymmetry is intentional — horizontal swipe must
  be deliberate; vertical scroll is the default.
- **400 ms duration** — a flick is fast (typically 150-300 ms). A
  drag-and-rest motion (which usually indicates the user is trying to
  select text or interact with a child element) takes longer. 400 ms
  comfortably accommodates a "lazy" swipe but rejects a slow drag.

These three are exported as module-level constants so a future spec
that wants to tune them per-page can pass `options` to the hook
without forking the implementation.

## (4) Reduced-motion: gesture fires, animation doesn't

Honouring `prefers-reduced-motion: reduce` is a hard accessibility
requirement (WCAG 2.3.3). The interpretation here:

- **Gesture itself stays functional** — swiping must still navigate.
  If we silently disabled the gesture under reduced-motion, users who
  set the preference for vestibular-disorder reasons would lose the
  shortcut entirely. The gesture isn't a decoration; it's a
  navigation affordance.
- **Animation feedback is throttled** — the hook returns a
  `reducedMotion: boolean` flag so the caller can dampen any
  CSS-driven slide-in / slide-out transitions. In this spec the
  consumers (MobileDetailFrame, MobileFormRunner) don't currently
  ship any directional animation (they just snap), so the flag is
  forward-compatible scaffolding. A `data-reduced-motion="true"`
  attribute is emitted on the swipe-region container so future CSS
  rules can read it.

This mirrors how the Apple HIG handles the same setting — the
"swipe to delete" row animation in iOS Mail still happens; the
springiness is just dampened.

## (5) MobileDetailFrame stays a server component

The frame is composed inside server components (every page that
calls `<MobileDetailFrame title={...}>`) so converting it to
`"use client"` would push every consumer's tree into the client
bundle. Instead, we introduce `MobileDetailSwipeRegion` as the
smallest possible client-component wrapper: it owns just the
`useRouter()` hook + the `useSwipe` ref. The rest of the frame
(header, body, sticky-save bar) stays server-rendered.

The router-back fallback to `router.push(backHref)` matters for
deep links. A user who lands on `/mentorship/cycles/abc-123` from
a WhatsApp link has `history.length === 1` — there's nothing to
pop. Pushing the listing keeps the back-arrow + back-swipe
semantically identical.

## Why we don't replace the tap affordances

Three reasons:

1. **Discoverability** — A new user sees the back arrow at the top
   and the Previous / Next buttons at the bottom. They never have to
   guess that a swipe might also work.
2. **Accessibility** — Screen readers and keyboard users don't fire
   pointer events. If the swipe were the only path, those users
   would be locked out.
3. **Reliability** — Touch screens occasionally misfire (a wet finger,
   a screen protector with a bubble). A failing swipe leaves the tap
   target as the canonical fallback — the user is never stuck.

Swipes are a productivity enhancement layered on top of the
existing chrome, not a replacement.
