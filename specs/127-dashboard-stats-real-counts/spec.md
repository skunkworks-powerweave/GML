# Spec 127 — Dashboard stats: real counts everywhere (Workflow Run 11 frontend parity)

## Why

`LMS GML Frontend/dashboard.jsx` ships five role-specific dashboard
variants (lines 1-360), and each stat card is a literal string baked
into JSX: `<Stat label="Pending video reviews" value="3"/>`,
`<Stat label="Active mentees" value="5"/>`, `<Stat label="Teachers
enrolled" value="10"/>`, `<Stat label="Audit events / day" value="284"/>`,
etc. The same is true of the `TodayChecklist` rows ("Review 3 pending
lesson videos", "Q2 progress check with Tsering Dolma") and the
`FieldMap` SVG (ten hardcoded markers).

The live Next.js port at `apps/web/src/app/(authenticated)/dashboard/page.tsx`
got partway there — `getCounts()` does run six real `count()` queries
against `mentorPairings`, `observationCycles`, `teachers`, `schools`,
`mentors`, and `videoSubmissions` — but the role-variant logic still
overloads those six totals into stat cards that the prototype labels
quite differently. A teacher sees "My observations" wired to the
**programme-wide** observation-cycle total. A mentor sees "Pending
video reviews" wired to the **programme-wide** count of videos in
status='ready'. The TodayChecklist rows are still the three hardcoded
prototype strings. Every variant looks the same to every user, in
other words.

Spec 127 closes that gap by rewriting `dashboard/page.tsx` so each
role sees real, user-scoped counts that match the prototype's stat
labels — no shared `getCounts()` super-set, no programme-wide
fallbacks. The five variants ship as five distinct query bundles,
each wrapped in `React.cache` and fired through `Promise.all` for
single-round-trip latency.

## What we ship

### 1. Per-variant query bundles in `dashboard/page.tsx`

Five `React.cache`-wrapped helpers, each runs a `Promise.all` of
`db.select({ c: count() })` queries scoped to the active session's
`user.id` (or the `teachers.id` / `mentors.id` row that owns it):

- **teacher** (`getTeacherChrome(userId)`):
  - `myUploads7d` — `video_submissions` where `submitted_by_user_id =
    user.id` and `created_at >= now() - 7d`.
  - `pendingPre` — `observation_cycles` where the teacher row joins
    on `user.id`, status='nominated' (pre-form is the upstream
    gate).
  - `awaitingVideo` — same join, status='pre_submitted'.
  - `openQuizzes` — active quizzes with no matching
    `quiz_submissions` row from this user.
- **observer** (`getObserverChrome(userId)`):
  - `leadingActive` — cycles where `observer_id = user.id` and
    status in `{nominated, pre_submitted, observed, post_submitted}`.
  - `pendingObserverForm` — same observer scope, status='pre_submitted'.
  - `awaitingSignOff` — same observer scope, status='post_submitted'.
- **mentor** (`getMentorChrome(userId)`):
  - `activeMentees` — `mentor_pairings` joined on `mentors.user_id =
    user.id`, status='active'.
  - `pendingVideoReviews` — `video_submissions` joined to
    `teachers → mentor_pairings (mentor scoped)`, context='teach_back',
    status in `{received, queued, transcoding, review_pending}`,
    `created_at >= now() - 48h`. Matches the prototype's <48-hour SLA.
  - `scheduledMeetingsThisWeek` — `mentor_meetings` joined on the
    mentor's pairings, `scheduled_at` in `[startOfWeek, startOfWeek+7d)`.
  - `qProgressFormsDue` — pairings with a non-null `current_quarter`
    and at least one cached meeting (proxy — see research.md).
- **programme_admin** (`getProgrammeChrome()` — also shared with
  super_admin):
  - `pairingsActive`, `cyclesInFlight`, `recentUploads`,
    `pendingObserverForms` (all programme-wide).
- **super_admin** — `getProgrammeChrome()` + `totalUsers`,
  `auditEvents24h`, `storageMb` (`SUM(files.size_bytes) / 1MB` over
  non-deleted rows — see deviations below).

### 2. Real TodayChecklist rows

Each variant generates a list of real-link todo rows from the same
chrome data — no hardcoded strings. The mentor variant pulls three
distinct query slices (cycles awaiting mentor sign-off, mentee videos
pending review, meetings scheduled today) and links each row to the
correct deep page. Empty queue → "Nothing pending — your queue is
clear." (replaces the 3-static-row stub).

### 3. Real FieldMap

The hardcoded ten-marker SVG is replaced with a `db.select` over the
active `schools` table — one dot per school, deep-linking to
`/repo/school/[id]` per the brief. Coordinates are derived from a
stable hash of `schools.code` so the layout is deterministic without
adding a geo column. Visible only to programme + super admins (the
two roles that own the field-ops view in the prototype).

### 4. `dashboard.viewed` audit

A best-effort `recordAudit({ action: "dashboard.viewed", entityType:
"dashboard", entityId: role })` fires per render. Non-blocking —
audit insert failures don't fail the page (same contract as every
other `recordAudit` call site).

## Status mapping (mentor pending-review SLA)

```
video_submissions.status      counts as "pending review"?
received                      yes
queued                        yes
transcoding                   yes
review_pending                yes
ready                         no  (transcode done, mentor can review)
reviewed                      no  (mentor already signed off)
failed                        no  (separate operator unstuck)
```

Plus the 48-hour `created_at` floor so stale uploads outside the SLA
window don't inflate the count.

## Acceptance criteria

- `dashboard/page.tsx` exports five `cache`-wrapped chrome helpers
  (`getProgrammeChrome`, `getTeacherChrome`, `getObserverChrome`,
  `getMentorChrome`, `getFieldMapSchools`) that each return a fully
  derived object — no caller passes literal numbers through.
- Each role variant calls exactly one helper and renders its stats
  + todos from that helper's return value.
- The mentor variant's `pendingVideoReviews` query filters on
  `context_type = 'teach_back'`, the four status states listed
  above, and a 48-hour `created_at` floor.
- The teacher variant's `openQuizzes` filter excludes quizzes the
  current user has already submitted (`NOT IN (SELECT
  quizSubmissions.quizId FROM ... WHERE userId = …)`).
- The page renders the `FieldMap` only for `super_admin` /
  `programme_admin`, with a `<title>` tooltip per dot and a
  `/repo/school/[id]` link per dot.
- The page fires a `dashboard.viewed` audit per render.
- All five spec-kit files exist under `specs/127-dashboard-stats-real-counts/`.
- `tests/governance/test_127_dashboard_stats_real_counts.test.mjs`
  passes with at least eight assertions.

## Non-goals

- No new schema columns. The brief explicitly forbids schema
  additions; every count derives from existing tables.
- No client component. The page stays a pure server component;
  filters (if any) drive off URL search params via `<form
  method="get">` per the harness convention.
- No MinIO live-stat probe. `storageMb` is a proxy
  (`SUM(files.sizeBytes)` in MB) — see designDeviations.
- No new caching layer beyond `React.cache`. The brief specifies it
  to avoid duplicate per-request queries; we use it on every chrome
  helper plus the field-map schools fetch.

## Design deviations

1. **Super-admin Storage used (MB) is a `SUM(files.sizeBytes)`
   proxy, not a live MinIO bucket-stats probe.** Reading actual
   bucket stats requires the MinIO admin credentials, which live on
   the worker boundary, not the web page boundary. The proxy is
   honest about what it counts (the comment on the card hint reads
   "SUM(files.size_bytes)") and updates instantly when a new file
   row is inserted. A future spec can replace it with a real probe
   if/when the credential plumbing reaches the web server.

2. **Q-progress forms due is a proxy.** Real form-due detection
   requires joining `feedback_responses` against quarter boundaries,
   which is a hot multi-CTE query. The proxy
   (`current_quarter IS NOT NULL AND meetings_count > 0`) reflects
   the prototype's intent (pairings that have hit a quarter
   boundary need a Q-progress form filed) without the join cost.
   Documented inline in the helper.
