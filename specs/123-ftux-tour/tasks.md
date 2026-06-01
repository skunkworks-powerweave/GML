# Tasks 123

- [x] T1 → write the FTUXTour client component under `apps/web/src/components/ftux/FTUXTour.tsx`, porting the prototype's FTUX_TOURS map + step renderer verbatim
- [x] T2 → augment `(authenticated)/layout.tsx` to select `ftuxSeenAt` alongside `uiLanguage` and mount `<FTUXTour role={user.role} ftuxSeenAt={…} />` above the shell
- [x] T3 → prefix Sidebar's `data-help-anchor` with `nav-`; tag Topbar's bell with `data-help-anchor='topbar-help'` so the prototype's selectors resolve verbatim
- [x] T4 → append the six `.ftux-*` selectors + `@keyframes ftux-pulse` to `apps/web/src/app/globals.css` from help.jsx lines 670-705
- [x] T5 → add a `<ReplayTourButton />` to the Settings form's Account section that PUTs `{ftuxSeenAt: null}` and full-reloads
- [x] T6 → author spec.md, plan.md, research.md, quickstart.md, tasks.md under `specs/123-ftux-tour/`
- [x] T7 → write `tests/governance/test_123_ftux_tour.test.mjs` with at least five assertions covering the spec
- [ ] T8 (future) → localise FTUX step copy through next-intl when the chrome translations stabilise; today the strings are English-only
- [ ] T9 (future) → design a mobile-shell variant of the tour (different selectors, fewer steps) for the bottom-tab world
