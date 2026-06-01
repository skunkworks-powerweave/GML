# Spec 064 — RTT Online · Synchronous

## Context

The RTT (Refresher Teacher Training) programme runs in two modalities: a face-to-face
cohort cycle, and an online complement that splits into **asynchronous** (recorded
content, lesson packets, off-line readings) and **synchronous** sessions
(webinars, live quizzes, live discussions). The synchronous surface is the live
calendar — what's coming up, who's running it, and when to log in.

Spec 062 (`/rtt`) ships the phase × subject matrix and spec 063 (`/rtt/subject/[id]`)
shows the per-subject drill-in. This spec — `/rtt/online/synchronous` — opens the
third RTT route group, the *online hub*. The hub will eventually have two leaves:

- `/rtt/online/asynchronous` (recordings + readings; out of scope for 064)
- `/rtt/online/synchronous` (this spec)

Both pull from the same `rtt_sessions` table, distinguishing scope via the `type`
column. Synchronous = `synchronous | webinar | quiz`. Asynchronous = `asynchronous`.

## Functional requirements

- **FR-1 Calendar surface.** Render a 3-week Mon-Fri grid. Each cell is one
  weekday. Each scheduled `rtt_session` with `type ∈ {synchronous, webinar, quiz}`
  appears as a chip inside its date cell, showing start time + title +
  facilitator (sourced from `rtt_sessions.notes` since the schema has no
  facilitator FK).
- **FR-2 Upcoming side panel.** A right-rail list shows the next 5 upcoming
  synchronous sessions (ordered ascending by `scheduledAt`). Each card carries a
  type pill (webinar / live quiz / live), date+time stamp, subject and phase
  trail, facilitator (if known), and a "Join link" link if the session row has
  `linkOrRecording` populated.
- **FR-3 Type colour-coding.** Webinar → indigo soft, Live quiz → saffron soft,
  generic synchronous → lichen soft. Mirrors the status-pill convention used by
  `mentorship/page.tsx` so an operator instantly distinguishes session kind.
- **FR-4 Empty state.** If no rows match the window or the table is empty,
  render a card-style empty state directing the operator to
  `/admin/data/sessions` to schedule new entries. Uses `var(--ink-3)` muted
  copy.
- **FR-5 Authentication.** Server component; reads `auth()` and redirects to
  `/login` if no session. No role gate beyond authentication — all authenticated
  users (teacher, mentor, observer, admin) can see the calendar.
- **FR-6 Schedule-window filter.** SQL filter on `scheduledAt >= weekStart`
  bounds the read so an old session backlog doesn't bloat the result set. The
  3-week window is enforced client-side; rows further out feed only the
  side-panel "upcoming 5" if any of them fall inside it.
- **FR-7 Subject / phase trail.** Each row resolves through `rtt_subjects →
  terms → phases` via `leftJoin` so the upcoming card can show context like
  `Functional English · Phase 2 · Term 1`.

## Acceptance criteria

- AC-1 The route renders at `/rtt/online/synchronous` and exports
  `dynamic = "force-dynamic"`.
- AC-2 The page calls `auth()` from `@/auth` and redirects unauthenticated
  visitors to `/login`.
- AC-3 The DB query filters `rtt_sessions.type` to the synchronous set via
  drizzle `inArray` and excludes rows where `scheduledAt IS NULL`.
- AC-4 The 3-week grid header reads "3-week calendar" and includes a date-range
  caption rendered with `var(--mono)`.
- AC-5 Each upcoming card uses one of the type pills in
  `{webinar, quiz, synchronous}` mapped to the indigo / saffron / lichen
  accent tokens.
- AC-6 Empty state copy reads "No webinars scheduled. Schedule via
  /admin/data/sessions" and the link routes to `/admin/data/sessions`.
- AC-7 The h1 reads "Online · Synchronous" rendered in `var(--serif)` (Crimson
  Pro), the eyebrow reads "RTT online hub".

## Out of scope

- Editing or scheduling sessions (handled by `/admin/data/sessions` — spec 012
  registry framework).
- Asynchronous content surface (`/rtt/online/asynchronous` — separate spec).
- RSVP / attendance marking (attendance lands via `rtt_attendance` table; this
  page is read-only).
- Calendar export (iCal / Google Cal) — not requested in v1.
