# Spec 123 — FTUX (First-Time UX) coach-marks

## Why

The JSX prototype's onboarding sequence (`LMS GML Frontend/help.jsx`
lines 489-573) shows a four-or-five-step coach-mark overlay the very
first time a user signs in. It points at the sidebar items they will
use most, then at the topbar's info affordance, and closes with a
"Help is always here" reassurance. Specs 029 and 030 dropped both the
help dictionary panel *and* the FTUX layer from the v2 build because
neither blocked a workflow. The frontend-parity audit in workflow
run 10 surfaces FTUX as a previously-DROPPED feature the user has
explicitly asked us to revive: the audit calls it out as one of the
six dropped affordances that are nevertheless materially in the JSX
prototype. Reviving it is small (one client component, one CSS block,
one settings link, one server-side prefs read) and the table column
the storage layer needs already exists on `user_prefs.ftux_seen_at`
— it was added speculatively as part of the same milestone that
shipped the Tweaks Panel (spec 024). No migration is required.

## What this spec ships

- **`apps/web/src/components/ftux/FTUXTour.tsx`** — a `'use client'`
  overlay that mounts only when `ftuxSeenAt === null`. It reads a
  role-keyed step list verbatim from the prototype's `FTUX_TOURS`
  map (mentor, teacher, programme_admin, with `super_admin` aliased
  to `programme_admin` and `observer` aliased to `mentor` to mirror
  help.jsx lines 484-485). Each step queries `document.querySelector`
  against a `data-help-anchor` selector to compute the spotlight
  rect; on resize / scroll the rect recomputes (capture-phase scroll
  so nested scrollers retarget too).
- **`apps/web/src/app/(authenticated)/layout.tsx`** — augments the
  existing `user_prefs` read (it already pulled `uiLanguage` for the
  next-intl wrapper) to also select `ftuxSeenAt`. Passes both into
  the FTUX overlay alongside the role.
- **`apps/web/src/components/nav/Sidebar.tsx`** — prefixes
  `data-help-anchor` with `nav-` so the prototype's selectors
  (`[data-help-anchor='nav-mentorship']`, etc.) match.
- **`apps/web/src/components/nav/Topbar.tsx`** — tags the bell
  button with `data-help-anchor='topbar-help'`. This is the
  right-cluster's info affordance until the full help panel
  (spec 029) ships; tagging the bell preserves the "Help is always
  here" step without inventing a new control.
- **`apps/web/src/app/globals.css`** — appends the `.ftux-root`,
  `.ftux-backdrop`, `.ftux-ring`, `.ftux-caption`, `.ftux-dots`,
  `.ftux-dot` selectors + the `ftux-pulse` keyframes 1:1 from
  help.jsx lines 670-705.
- **`apps/web/src/app/(authenticated)/settings/settings-form.tsx`** —
  adds a "Replay tour →" link to the Account section. Clicking it
  PUTs `{ftuxSeenAt: null}` into `/api/user-prefs` and reloads the
  page so the layout's server-side read picks up the cleared
  timestamp.

## Why no migration

`packages/db/src/schema/prefs.ts` already declares
`ftuxSeenAt: timestamp(...)` (a nullable column without a default).
The 0008 migration that introduced `user_prefs` shipped it as part of
the same DDL — verified before writing this spec. The
`/api/user-prefs` route already accepts a nullable `ftuxSeenAt`
string in its Zod schema (it landed alongside the Tweaks Panel). The
upsert path correctly translates the string into a `Date` object and
passes it into the Drizzle insert.

## Behaviour

1. New user signs in. `(authenticated)/layout.tsx` finds no
   `user_prefs` row (or one whose `ftuxSeenAt` is null), passes
   `ftuxSeenAt={null}` into the `<FTUXTour>` overlay.
2. The overlay paints. Step 1 of the role-specific list highlights
   its target via a `<svg>` mask cutout + a pulsing ring.
3. Next, Back and Skip controls drive the step pointer. Skip + Got
   it both call `finish()`, which PUTs `{ftuxSeenAt: now}` and hides
   the overlay locally (so the user doesn't need a refresh).
4. From `/settings`, "Replay tour →" PUTs `{ftuxSeenAt: null}` and
   reloads. The overlay re-mounts on the next paint.

## What we explicitly do not do

- No help dictionary panel. Spec 029 stays dropped.
- No "?" keyboard shortcut to reopen the tour. Replay is via the
  settings link only.
- No mobile-specific tour. On mobile the selectors will miss because
  the bottom-tab markup uses different anchors; the caption falls
  back to the prototype's `{top:100,left:100}` position and the ring
  doesn't paint. FTUX is a desktop pedagogical layer in this build.
- No localisation of step copy. Strings are English. Spec 125's
  next-intl wiring covers the chrome but the FTUX steps remain
  hard-coded for v2.

## Acceptance criteria

- `FTUXTour.tsx` exists, is a `'use client'` component, reads
  `ftuxSeenAt` and `role` from props, and renders no DOM when
  `ftuxSeenAt` is set or when the role's step list is empty.
- `(authenticated)/layout.tsx` selects `ftuxSeenAt` from
  `user_prefs` and passes it through.
- Sidebar.tsx emits `data-help-anchor` values prefixed with `nav-`.
- Topbar.tsx tags the bell with `data-help-anchor='topbar-help'`.
- globals.css declares all six `.ftux-*` selectors + the
  `@keyframes ftux-pulse` keyframes.
- settings-form.tsx renders a "Replay tour →" button that PUTs
  `{ftuxSeenAt: null}` and reloads.
- `tests/governance/test_123_ftux_tour.test.mjs` passes with at
  least five assertions covering the above.
