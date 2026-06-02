# Spec 137 — Mobile detail-page chrome (Workflow Run 12 — final frontend parity)

## Why

The JSX prototype `LMS GML Frontend/mobile-details.jsx` (334 LOC) defines
the common chrome that wraps every detail page on mobile:

- Thin top header (44px) with var(--paper-2) background, back arrow on
  the left, page title centered with ellipsis truncation, optional
  right-side icon slot.
- 16px body inset for the content area.
- Optional sticky bottom bar for primary "save" / "sign-off" actions on
  forms, so a long-scroll detail page can always reach its primary CTA.
- `safe-area-inset-top` and `safe-area-inset-bottom` env() respected so
  the chrome doesn't collide with the iOS notch / Android camera cutout
  or the home indicator.

The live ports of the detail pages (`/mentorship/[pairingId]`,
`/observation/[cycleId]`, `/repo/school/[id]`, `/repo/class/[id]`,
`/repo/teacher/[id]`, …) render their desktop two-column layouts on
mobile too. On a 360px-wide phone, the JSX horizontal scroll and the
deep back-button hike-up to the parent listing both became friction
points in the prototype walkthrough — the mobile-details chrome is the
intentional answer to both.

Spec 137 ships the chrome **once** as a reusable wrapper and adopts it
on the major mobile detail surfaces, so adding new detail pages costs
3 lines of code instead of copy-pasting a 40-line header.

## What we ship

### 1. `apps/web/src/components/shells/MobileDetailFrame.tsx` (CREATED)

Server-component-safe wrapper exporting `MobileDetailFrame({ title,
backHref, rightAction?, stickyAction?, children })`.

- **Header** — 44px tall, `position: sticky; top: 0`, var(--paper-2)
  bg, `borderBottom: 1px solid var(--line)`, `paddingTop:
  env(safe-area-inset-top, 0)` for notch devices. Three columns
  (44px / 1fr / 44px) so the title stays visually centered regardless
  of whether `rightAction` is provided.
- **Back arrow** — `<Link href={backHref}>` wrapped in a 44x44
  touch-target box (Apple HIG / Material Design minimum). The visual
  arrow glyph is centered inside via flexbox. `aria-label="Back"` so
  screen readers announce the affordance correctly even though the
  glyph is `aria-hidden`.
- **Title** — `<h1>` with var(--serif) font, ellipsis truncation,
  fallback `title={title}` attr so a hover reveals the full string when
  it has been clipped.
- **Body** — `<main>` with 16px horizontal padding. Vertical padding
  is left to caller content because the header above already consumed
  safe-area-inset-top.
- **Sticky bar** — when `stickyAction` is provided, a fixed-position
  `<div>` at `bottom: 64px` (above BottomTabs) with
  `paddingBottom: calc(10px + env(safe-area-inset-bottom, 0))` so the
  action button sits clear of the iPhone home indicator. Sits at
  zIndex 19 (BottomTabs is zIndex 20) so it never overlaps the nav.

The wrapper is composed inside `MobileDetailSwipeRegion` (spec 139)
which adds the rightward-swipe-to-go-back gesture — additive to the
back-arrow tap target, never replacing it.

### 2. `apps/web/src/components/shells/index.ts` (EDITED)

Re-exports `MobileDetailFrame` and the props type so adopting pages can
import from `@/components/shells` instead of the deep path.

### 3. Five detail-page adoptions (EDITED)

Each page wraps its existing JSX in `device === "mobile" ?
<MobileDetailFrame …>{body}</MobileDetailFrame> : body`. The
data-fetching, audit, and role-gate logic above the `return` is
untouched in every case.

- `apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx` —
  `title = "{mentorName} ↔ {teacherName}"`, `backHref = "/mentorship"`.
- `apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx` —
  `title = {teacher.fullName}`, `backHref = "/observation"`, and the
  "Sign off cycle" CTA migrates to `stickyAction` when
  `canSignOff === true` so it's always reachable on a long scroll.
- `apps/web/src/app/(authenticated)/repo/school/[id]/page.tsx` —
  `title = {school.name}`, `backHref = "/repo/schools"`.
- `apps/web/src/app/(authenticated)/repo/class/[id]/page.tsx` —
  `title = "Grade {n} · {schoolCode}"`, `backHref = parent school` so
  the back arrow walks the repo tree the same way the inline ← link did.
- `apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx` —
  `title = {teacher.fullName}`, `backHref = "/repo/teachers"`.

## Acceptance criteria

- `MobileDetailFrame.tsx` exists at the shells path with the documented
  prop contract.
- The component renders a 44x44 back-arrow Link, a centered title with
  ellipsis truncation, and an optional sticky bottom bar.
- The header uses `env(safe-area-inset-top, 0)` for the notch.
- The sticky bar (when rendered) uses `env(safe-area-inset-bottom, 0)`
  for the home indicator.
- The five detail pages import `MobileDetailFrame` and conditionally
  wrap their body based on `getDeviceType()`.
- Desktop renders are unchanged — `device === "desktop"` paths still
  emit the original two-column JSX with no wrapping chrome.
- All five spec-kit files exist under `specs/137-mobile-details-chrome/`.
- `tests/governance/test_137_mobile_details_chrome.test.mjs` passes
  with at least six assertions covering the above.

## Non-goals

- **No client-only state in the frame.** The frame is a sync server
  component so RSC streaming works; gesture handling lives in the
  separate `MobileDetailSwipeRegion` client island.
- **No schema, no env, no new dependencies.** Pure UI composition over
  existing primitives.
- **No edits to the desktop shells.** `DesktopShell.tsx` and the
  two-column page bodies render identically on `>= 768px` viewports.
- **No "edit in place" mode.** The right-action slot accepts a JSX
  node and adopting pages compose their own buttons; spec 137 does not
  prescribe what goes there.
- **No keyboard shortcut layer for back nav.** The browser back button
  and `Escape` are already accepted UX on web; adding `Backspace ←` or
  similar would collide with form-input focus handling.
