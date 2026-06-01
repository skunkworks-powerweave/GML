# Tasks 122

- [x] T1 → port HELP dictionary from `LMS GML Frontend/help.jsx`
  to `apps/web/src/lib/help.ts` as a frozen TypeScript object;
  export `HELP_GROUPS`, `HELP_KEYS`, `helpFor()` and
  `searchHelp()` helpers.
- [x] T2 → write HelpPanel, HelpTip, HelpDot, HelpHeadbtn as
  `'use client'` islands under `apps/web/src/components/help/`;
  expose the canonical `openHelp()` event dispatcher and the
  `useHelpShortcut()` orthogonal hook.
- [x] T3 → add `/api/helpdesk/tickets` POST route that validates
  with Zod, fans out a notification per active admin, writes
  the `helpdesk.ticket_opened` audit event, and returns
  `{ ok, delivered }`. Other methods return 405; no session
  returns 401.
- [x] T4 → mount `<HelpPanel contact={…}>` in
  `(authenticated)/layout.tsx` alongside the existing
  AntiDownloadGuard and FTUXTour. Pass helpdesk contact via
  props (no client-side env reads).
- [x] T5 → write `tests/governance/test_122_help_panel_and_dictionary.test.mjs`
  with 8+ assertions covering dictionary breadth, component
  shape, route behaviour, layout wiring and spec-kit files.
- [x] T6 → author spec.md, plan.md, research.md, quickstart.md,
  tasks.md under `specs/122-help-panel-and-dictionary/`.
- [ ] T7 (deferred) → wrap real terms on the live pages
  (`Cycle`, `Pairing`, `Phase`, etc.) with `<HelpTip>` so the
  dotted-underline affordance actually surfaces in the product.
  This spec lands the primitive; the wrapping pass is a
  drive-by we'll bundle with the next page-touch spec.
- [ ] T8 (deferred) → dedicated `helpdesk_tickets` table + admin
  list view with a status pipeline. Notifications-as-tickets is
  the lighter path for v1; promote to a dedicated table when
  ticket triage requires it.
