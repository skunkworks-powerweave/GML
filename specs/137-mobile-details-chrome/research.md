# Research 137

Five design choices documented inline in the touched files.

(1) **MobileDetailFrame is a sync server component, not a client island.**
The JSX prototype suggests no client-only state for the chrome itself
(no toggles, no animations driven by JS). Keeping the wrapper as a sync
server component means RSC streaming keeps working for the
detail-page body — the page's `await db.select(...)` calls land
straight into the streamed response, and the chrome's HTML emits in
the same first-paint pass. The optional swipe-back gesture is the only
client-side concern; we delegate that to `MobileDetailSwipeRegion`
(spec 139), which is a `"use client"` wrapper that imports
`useRouter()` + `useSwipe()`. Composition keeps each layer's concern
small.

(2) **Header uses CSS Grid with three 44px / 1fr / 44px columns, not
flex with `justify-content: space-between`.** Grid guarantees the title
stays *visually* centered regardless of whether the `rightAction` slot
is occupied — a flex layout would shift the title 22px to the right
when no right-action is present, which the prototype's screenshots
contradict. The 44x44 right-cell is always rendered as an empty box
so the grid template is stable; the cell renders `{rightAction ??
null}`. This costs zero pixels on screens and matches the prototype's
intent.

(3) **Back arrow is a `<Link>` not a `<button>` triggering
`router.back()`.** Two reasons. First, `<Link>` is SSR-renderable; a
button would force the chrome into a client boundary or require a
client-island wrapper just for the click handler. Second, deep-linked
entries (a user opens `/observation/<uuid>` directly from a WhatsApp
notification) have an empty history stack — `router.back()` would
either no-op or navigate to a previous origin. `<Link href="/observation">`
is the explicit, predictable parent. The swipe-region client island
(spec 139) handles `router.back()` with a fallback to the same
`backHref`, so the gesture and the tap both end up at the same place
in the listing.

(4) **Sticky bar sits at `bottom: 64px`, not `bottom: 0`.** BottomTabs
(spec 026) render at `bottom: 0` with `zIndex: 20` and their own
`paddingBottom: env(safe-area-inset-bottom, 0)`. A second fixed
container at `bottom: 0` would stack on top and consume an extra ~56px
of viewport — too much for a 360x640 phone. Sitting at `bottom: 64px`
(BottomTabs' ~64px height including the safe-area inset) means the
sticky bar sits in the gap between the page body and the nav; it gets
its own `paddingBottom: calc(10px + env(safe-area-inset-bottom, 0))`
so the action button floats above the home indicator on iPhones with
rounded corners. zIndex 19 (BottomTabs is 20) so the nav always wins
overlap conflicts.

(5) **Sign-off CTA on observation/[cycleId] migrates to stickyAction,
not duplicated.** The desktop page renders the sign-off button in the
inline header; on mobile, leaving it there would push it off-screen as
soon as the user scrolls into the form sections (which the cycle page
is *all about*). Moving it into the sticky bar — only when
`canSignOff === true` — keeps the primary CTA reachable from any
scroll position. The desktop rendering is untouched (the header still
ships its button) because the device-aware branch returns the unwrapped
body for desktop.

## Why we don't auto-detect a "should be sticky" set of actions

The prototype is explicit: only "save"-class actions belong in the
sticky bar. Auto-detecting a set of buttons in the existing JSX and
hoisting them would be fragile (a future page adds an unrelated
button and gets it surprise-stickied). Leaving the choice in the
adopting page's hands costs ~3 lines (build a `stickyAction` const,
pass it as prop) and keeps the contract obvious.

## Why we adopt only on 5 pages, not all 27

The spec requirement is "at least 3 sample adoptions to prove the
pattern". We ship 5 (mentorship pairing, observation cycle, repo
school / class / teacher) — the highest-traffic detail surfaces and
the ones the JSX prototype explicitly screenshots. The remaining detail
pages (`/repo/mentor/[id]`, `/repo/session/[id]`, `/repo/subject/[id]`,
…) can adopt the frame in a follow-up batch once we see real-user
analytics on which mobile pages get the most traffic. The wrapper is
designed for trivial adoption (3 lines per page) so cost of catching
up is low.

## Why `data-testid` not classes

Governance tests + future e2e (Playwright) both want stable hooks.
`data-testid="mobile-detail-back"` etc. are queryable from
`page.getByTestId(...)` without ambiguity. Adding classes would risk
collision with the global `.btn-ghost` etc. utility classes already in
play. The chrome's visual style lives in inline `style` so we don't
introduce a CSS module for a 200-line component.

## Touch-target compliance

Apple HIG ≥ 44x44; Material Design ≥ 48x48. We ship 44x44 to match
the JSX prototype (which targets iOS first because the field deployment
is iPhone-heavy in Leh / Kargil). The visual arrow glyph is centered
in the box; the click target extends to the full 44x44. This is the
same pattern BottomTabs (spec 026) uses for its tab icons.
