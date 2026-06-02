# Tasks 137

- [x] T1 → write governance test (red) covering: MobileDetailFrame
  exists at the shells path, exports the named function, accepts the
  documented prop contract (title / backHref / rightAction? /
  stickyAction? / children), renders a 44x44 back-arrow Link with
  aria-label, renders the title centered with ellipsis truncation,
  uses env(safe-area-inset-top) and env(safe-area-inset-bottom), and
  the five adopting pages import and conditionally render the frame.
  Run suite → red.
- [x] T2 → create `apps/web/src/components/shells/MobileDetailFrame.tsx`:
  sync server component, sticky 44px header with 44px / 1fr / 44px
  grid, back-arrow Link 44x44, centered ellipsis-truncating h1,
  optional right slot, optional stickyAction div at bottom: 64px with
  safe-area-inset-bottom, composed inside MobileDetailSwipeRegion
  (spec 139) for the additive swipe-back gesture.
- [x] T3 → edit `apps/web/src/components/shells/index.ts`: re-export
  MobileDetailFrame + MobileDetailFrameProps so adopting pages import
  from `@/components/shells`.
- [x] T4 → edit `apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx`:
  import getDeviceType + MobileDetailFrame, capture existing JSX in a
  `body` const, return device === "mobile" branch wrapping with
  title="{mentor} ↔ {teacher}" and backHref="/mentorship".
- [x] T5 → edit `apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx`:
  same pattern; additionally build a stickyAction const that renders
  the Sign-off form button when canSignOff is true, pass into the
  MobileDetailFrame stickyAction slot. Desktop header still shows the
  inline button — only mobile path uses the sticky.
- [x] T6 → edit `apps/web/src/app/(authenticated)/repo/school/[id]/page.tsx`:
  same pattern with title=school.name, backHref="/repo/schools".
- [x] T7 → edit `apps/web/src/app/(authenticated)/repo/class/[id]/page.tsx`:
  same pattern; backHref resolves to parent school
  (`/repo/school/<id>`) so the back arrow walks the repo tree the same
  way the inline ← Link did.
- [x] T8 → edit `apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx`:
  same pattern with title=teacher.fullName, backHref="/repo/teachers".
- [x] T9 → author all five spec-kit files under
  `specs/137-mobile-details-chrome/`.
- [x] T10 → run the scoped governance suite
  (`pnpm test -- --grep "spec 137"`) → green. Run the full suite to
  confirm no regression in MobileShell, BottomTabs, or the desktop
  paths.
- [ ] T11 (future) → adopt MobileDetailFrame on the remaining 22 detail
  pages (`/repo/mentor/[id]`, `/repo/session/[id]`,
  `/repo/subject/[id]`, `/repo/resource/[id]`, `/admin/data/<entity>/[id]`,
  `/videos/[id]`, etc.) in a follow-up batch.
- [ ] T12 (future) → wire `MobileDetailSwipeRegion` to honor a
  per-page `disableSwipe` prop so quiz pages with horizontal swiper
  carousels don't compete for the gesture.
