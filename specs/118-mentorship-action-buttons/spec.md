# Spec 118 — Mentorship Action Buttons (Workflow Run 9 Tier C)

## Why

The mentorship pairing-detail page (`/mentorship/[pairingId]`) shipped in
spec 067 as a read-only surface: it queried `mentor_pairings`,
`mentor_meetings`, and `feedback_responses` and rendered the quarter
strip, meetings list, and concept note. The JSX prototype at
`LMS GML Frontend/mentorship.jsx` (lines 100-258), however, places six
distinct interactive elements on that surface — none of which were
wired in the v1 build:

1. **"Log meeting"** button (prototype L124) — opens a small form
   capturing `scheduledAt`, `durationMin`, `notes`, then inserts a
   `mentor_meetings` row and bumps the pairing's cached counters.
2. **"WhatsApp"** button (L123) — generates a `wa.me/<phone>?text=...`
   link and opens WhatsApp Web/app with the mentee's phone prefilled.
3. **"Message"** button (L122) — opens an internal messaging surface.
4. **Quarter strip Q1-Q4** (L130-158) — clicking a quarter card opens
   the matching `/forms/<kind>-<audience>-<version>` runner with
   `?pairingId=` and `?quarter=` query params.
5. **Commitments register checkboxes** (L244) — toggling a checkbox
   marks the commitment done/undone.
6. **Mark complete CTA** — *synthesized* from the schema (the JSX
   prototype lacks an explicit "Complete pairing" button, but
   `pairing_status` includes `"complete"` and seed data sets
   `p09.status="complete"`, so the workflow must exist somewhere).
   Role-gated to `super_admin` + `programme_admin`.

Without those wirings, the JSX→reality gap on this surface is
six interactive elements deep. A mentor opening the page sees the
buttons (because they're styled into the layout) but clicking does
nothing — the worst-possible UX state: visible-but-dead controls. The
89-gap frontend-parity audit ranks this surface as Tier C (highest
impact); spec 118 closes it.

## What

Wire all six interactive elements. The page stays a **server
component** — no client boundary added — by leveraging Next.js
Server Actions for the three mutations (log-meeting, complete,
commitment-toggle) and plain `<Link>` / `<a target="_blank">` for the
three navigations (WhatsApp, Message, quarter-strip→forms).

Specifically:

- **`apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts`**
  (new) — three server actions:
  - `logMeetingAction(formData)` — validates `pairingId` +
    `scheduledAt`, optional `durationMin` + `notes`; inserts into
    `mentor_meetings` inside a transaction that also bumps
    `mentor_pairings.meetings_count` (via `sql\`+ 1\`` to avoid the
    read-modify-write race) and `last_meeting_at`. Audits
    `mentor.meeting.logged` with `{pairingId, scheduledAt}`. Calls
    `revalidatePath` then `redirect` back to the detail page.
  - `completePairingAction(formData)` — `requireRole(["programme_admin",
    "super_admin"])` first; UPDATE `mentor_pairings SET status='complete',
    ended_at=now()` for the given `pairingId`. Audits
    `mentor.pairing.completed`. Idempotent: if no row updates the
    user is bounced back with `?error=pairing_not_found`.
  - `toggleCommitmentAction(formData)` — **v1 audit-only stub.** No
    `commitments` jsonb column exists on `mentor_pairings` yet; this
    spec deliberately does **not** add the migration (the v2 patch
    will land alongside the broader commitments-feature spec). For
    now the action records `mentor.commitment.toggled` with
    `{pairingId, index, done, text}` so the user click is captured
    in the audit log and can be replayed when the column lands.
    See `research.md` for the deviation rationale.

- **`apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx`**
  (edited) — adds:
  - Top-of-page session/auth check via `auth()` from `@/auth` (the
    existing route is already behind the `(authenticated)` group
    middleware, but the role gate for "Complete pairing" needs the
    role from `session.user.role` and the page also derives a
    `canComplete` boolean for conditional render).
  - Action-button row in the page header: Message link, WhatsApp
    link (disabled-styled chip when teacher phone is missing),
    "+ Log meeting" link to `?logMeeting=1`, and (role-gated)
    "Complete pairing" submit-button form.
  - Inline "Log meeting" form, conditionally rendered when
    `?logMeeting=1` is in the URL. Native `<form action={logMeetingAction}>`
    so no client component is required.
  - Quarter strip cards now carry a "Fill progress form →" or
    "View responses →" `<Link>` to the corresponding `/forms/<slug>`
    runner. Slug is computed from `QUARTER_TO_KIND[qNum]` +
    `DEFAULT_AUDIENCE` + `FORM_VERSION` (e.g.
    `progress_1-mentor-1?pairingId=<id>&quarter=2`).
  - Commitments register card (newly added). Renders a small static
    seed of four common commitments as rows, each wrapped in its own
    `<form action={toggleCommitmentAction}>`. Persistence is deferred;
    the audit row carries the toggle event.

## Why not add the `commitments` jsonb column now?

Two reasons we explicitly route around it:

1. **Scope discipline.** This spec's mandate is closing six interactive
   gaps on a single page. Adding a schema column drags in a migration,
   seed data, the existing seeded pairings, and potentially the
   admin-CRUD registry — all of which are out of Tier C's brief.
2. **Audit replay covers it.** Because every toggle writes an audit
   row with `{index, done, text}`, the future migration can backfill
   the column from `audit_log` rows where
   `action='mentor.commitment.toggled'`, ordered by created_at, last
   write wins. The data is not lost — it's just not yet
   materialized.

The follow-up migration is flagged in `research.md`.

## Acceptance criteria

- `apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts`
  exists with `"use server"` and exports `logMeetingAction`,
  `completePairingAction`, `toggleCommitmentAction`.
- `actions.ts` calls `recordAudit` with actions
  `mentor.meeting.logged`, `mentor.pairing.completed`, and
  `mentor.commitment.toggled`.
- `actions.ts` calls `requireRole(["programme_admin", "super_admin"])`
  inside `completePairingAction`.
- `actions.ts` increments `mentor_pairings.meetings_count` via a SQL
  expression (not a read-then-write) inside `logMeetingAction`.
- `page.tsx` imports all three actions from `./actions` and renders
  a `<form action={logMeetingAction}>`, a `<form action={completePairingAction}>`,
  and `<form action={toggleCommitmentAction}>`.
- `page.tsx` renders a WhatsApp `wa.me/...` link when the teacher has
  a phone on file, and a disabled-styled placeholder otherwise.
- `page.tsx` quarter-strip links route to
  `/forms/<kind>-mentor-1?pairingId=<id>&quarter=<n>`.
- All five spec-kit files exist under
  `specs/118-mentorship-action-buttons/`.
- `tests/governance/test_118_mentorship_action_buttons.test.mjs`
  passes locally with at least 8 assertions.
- `pnpm test`, `pnpm build`, `pnpm -r typecheck` all stay green.

## Non-goals

- No new database columns. The `commitments` jsonb is deferred to a
  future migration.
- No new internal messaging system. The "Message" button points at
  `/inbox?to=<userId>` which is the existing v1 inbox; threaded
  messaging is a separate epic.
- No realtime updates. After "Log meeting" the page is revalidated
  via `revalidatePath` and the user sees the new row on the
  server-rendered refresh — no WebSocket needed for v1.
- No optimistic UI. Every action is a native form post that re-renders
  the page server-side.
