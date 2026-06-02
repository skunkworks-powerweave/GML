# Spec 168 — Half-wired features finish (Workflow Run 16 post-audit hardening)

## Why

Workflow Run 16 began with a fresh sweep over the codebase after Run
15's audit-closure pass. The sweep surfaced four features that were
"half-wired" — they had a backend store and an admin surface, but the
values never flowed back into the rest of the UI; users couldn't tell
whether the knob had any effect:

1. **`system_settings` consumers** (spec 124 created the table + the
   `/admin/system-settings` page). The five sections (Programme, Video
   pipeline, Notifications, Backups, status display) accept input,
   persist it, and audit the change — but no other page READS the
   row. The programme name on the admin home is hardcoded
   `"Goldenmile RTT"`, the video upload modal shows a fixed `480p`
   explainer, and the notifications bell ignores the per-kind enable
   matrix. An admin who toggles a notification category off would
   still see the bell badge count notifications of that kind.

2. **`/login/forgot` SMTP-awareness**. Spec 161 shipped the page +
   the no-enumeration API contract. The API silently no-ops the send
   when `SMTP_HOST` is unset (the LAN-only Ladakh deployment
   scenario) but the page renders the form unconditionally — a user
   types their email, sees "Check your email", and never receives
   anything. They contact support, an operator investigates, and
   only then learns that SMTP was never configured on this
   deployment.

3. **`/admin/transcode-jobs` Redis-down banner**. Spec 162 wired the
   live BullMQ queue depth strip + try/catch'd the `getJobCounts()`
   call so a Redis outage doesn't crash the page. The fail-shape is
   "show the strip with `null` and render a faint 'depth unavailable'
   hint inside" — but an operator scanning the page for actionable
   data could easily miss the hint. The historical table below is
   still accurate (it queries Postgres directly, not Redis), but the
   page gives no clear signal that the LIVE depth is stale.

4. **`/repo/students` name search**. Spec 158 added inline name search
   to every `/repo/*` index EXCEPT `/repo/students` — the page writes
   an SM-9 audit row on every render and an un-deduped search would
   flood the audit log (typing "kunzang" one letter at a time = 7
   audit rows). The exclusion was the safest pre-spec-168 call, but
   the missing surface is a real gap: programme admins searching for
   a learner by name have to scroll through 100-row pages or do a CSV
   export.

Each of the four is a real "the feature appears to work, but it
doesn't" hazard. This spec closes all four in one batch because they
share a common shape (back-end is live, front-end is missing) and
because their governance test grew to overlap one another.

## What we ship

### `apps/web/src/lib/system-settings.ts` (CREATED)

A tiny `getSystemSettings()` loader wrapped in `React.cache(...)` so
the singleton row is fetched once per request even when multiple
server components read from it (layout + admin home + videos page).
Fail-shape: any thrown error returns `null` so consumers can fall
back to schema defaults without crashing the page.

### `apps/web/src/lib/audit.ts` (EDITED — extended)

New `recordAuditDedup({...args, dedupKey, ttlSeconds})` helper. SELECTs
audit_log for a matching row (action + userId + metadata.__dedupKey)
in the last ttlSeconds; if found, skips the INSERT and returns `false`.
Otherwise INSERTs and returns `true`. The check isn't atomic — a tight
burst can produce a few duplicates — but the goal is "no 600 rows /
minute", not "exactly one row per (user × key × hour)".

### `apps/web/src/components/video/UploadModal.tsx` (EDITED)

Accepts a new `videoDefaultQuality?: string | null` prop and surfaces
it in the browser-upload explainer card: "transcodes to <quality>
HLS …". The videos page (the only caller) passes
`sysSettings?.videoDefaultQuality ?? "480p"` so the modal mirrors
whatever the admin has configured.

### `apps/web/src/lib/chrome-counts.ts` (EDITED)

`loadUnreadNotifications()` now reads `system_settings.notificationsEnabled`
and filters the count to only notifications whose `kind` is in the
enabled set. Edge cases:
- `enabledKinds === null` (loader threw / row missing) → unfiltered
  count (the previous spec-128 behaviour) so the bell never silently
  goes dark.
- `enabledKinds.length === 0` (admin has disabled every category) →
  return 0 without a DB call. Otherwise we'd build an `IN ()` clause
  that Drizzle would error on.

### `apps/web/src/app/(authenticated)/admin/page.tsx` (EDITED)

Header now reads `programmeName` + `academicYear` from
`getSystemSettings()` instead of the hardcoded "Goldenmile RTT". Falls
back to the schema defaults (Goldenmile RTT / 2026-27) when the row
hasn't bootstrapped. Adds a `data-testid="admin-home-header"` anchor
and a `data-testid="admin-programme-name"` so the governance test can
verify the wire-through.

### `apps/web/src/app/login/forgot/page.tsx` (REWRITTEN as server component)

Now a server component that reads `process.env.SMTP_HOST` at render
time. When SMTP is unset, renders a yellow banner (saffron-soft per
the design system) explaining that password reset is unavailable on
this deployment and pointing the user at their programme admin.
When SMTP is set, renders the existing client form (extracted to
`ForgotPasswordForm.tsx`). The /api/auth/forgot-password POST route
is unchanged — still returns 200 in both branches so the
no-enumeration contract holds.

### `apps/web/src/app/login/forgot/ForgotPasswordForm.tsx` (CREATED)

Client component carrying the form state, the fetch call, and the
success view. Extracted verbatim from the original spec-161 page so
the behavioural contract (POST shape, 429 surface, success copy) is
preserved byte-for-byte.

### `apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx` (EDITED)

The page already wrapped `transcodeQueue.getJobCounts()` in try/catch
and showed a faint hint inside the depth strip. Spec 168 adds an
explicit `redisUnavailable` flag and renders a saffron-soft banner
ABOVE the depth strip + table: "Live queue depth unavailable (Redis
is unreachable). The historical job table below is still accurate."
The banner is `role="alert"` so screen readers announce it on page
load.

### `apps/web/src/app/(authenticated)/repo/students/page.tsx` (EDITED)

Adds `?q=` ILIKE on `learners.name`, combined with the existing
school filter via `and(...)`. The audit-flood risk is closed via the
new `recordAuditDedup` helper — one `learners.search` row per
(user × query × hour). The existing `learners.bulk_view` audit row
still fires every render (the SM-9 contract), but the new search row
is a separate event that respects the dedup TTL.

### `tests/governance/test_158_repo_search_bars.test.mjs` (EDITED)

The assertion that pinned `/repo/students` as excluded from the
spec-158 search round is LOOSENED: the page MAY carry an ILIKE on
`learners.name` AS LONG AS it also calls `recordAuditDedup`. A
future contributor who adds the search without the dedup helper
still gets a red light first.

## Acceptance criteria

- `apps/web/src/lib/system-settings.ts` exists, exports
  `getSystemSettings` wrapped in `cache()`, SELECTs by
  `SYSTEM_SETTINGS_ID`, and limits to 1 row.
- `apps/web/src/lib/audit.ts` exports `recordAuditDedup` with the
  documented (AuditInput + dedupKey + ttlSeconds) signature, SELECTs
  `audit_log` filtered by action + userId + `metadata ->> '__dedupKey'`
  + `gte(createdAt, sinceCutoff)`, INSERTs only when no match exists.
- `UploadModal` accepts `videoDefaultQuality` and renders it inside
  the browser-upload explainer (via `data-testid="upload-quality-explainer"`).
- The videos page passes `sysSettings?.videoDefaultQuality ?? "480p"`
  to the modal.
- `loadUnreadNotifications` filters by `system_settings.notificationsEnabled`
  via `inArray(notifications.kind, enabledKinds)`.
- The /admin home renders `data-testid="admin-programme-name"` with
  the `programmeName` value from `getSystemSettings()`.
- `/login/forgot/page.tsx` is a SERVER component (no `"use client"`),
  reads `process.env.SMTP_HOST`, and conditionally renders either
  the banner (`data-testid="forgot-password-smtp-unavailable"`) or
  the `<ForgotPasswordForm />` client island.
- `/login/forgot/ForgotPasswordForm.tsx` exists, declares `"use client"`,
  and exports `ForgotPasswordForm`.
- `/admin/transcode-jobs/page.tsx` declares a `redisUnavailable`
  boolean and conditionally renders a `data-testid="dlq-redis-down-banner"`
  with the literal phrase "Live queue depth unavailable".
- `/repo/students/page.tsx` declares `q?: string` on its SearchParams,
  derives `qFilter`, calls `ilike(learners.name, …)`, and calls
  `recordAuditDedup` with `action: "learners.search"`, `entityType: "all"`,
  a dedupKey starting `q=` followed by the query and user, and
  `ttlSeconds: 3600`.
- `tests/governance/test_158_repo_search_bars.test.mjs` is updated:
  the `/repo/students` assertion now passes the loosened contract.
- All five spec-kit files exist under `specs/168-half-wired-features-finish/`.
- `tests/governance/test_168_half_wired_features_finish.test.mjs`
  passes with at least 12 assertions.

## Non-goals

- **No new dependencies.** All four features use stdlib + existing
  helpers (React.cache, drizzle's `inArray` / `ilike`, recordAudit).
- **No schema delta.** The `system_settings` table, `audit_log`, and
  `notifications` schemas are all unchanged. We just consume
  existing columns differently.
- **No new audit-action prefix.** `learners.search` reuses the
  `<entity>.<verb>` convention documented in
  `docs/audit-actions.md`.
- **No client-side debounce for the /repo/students search.** Same
  reasoning as spec 158: the search is a native GET form, the URL
  is the source of truth, no useState / no use-debounce dependency.
- **No realpath / SMTP-probe.** The forgot-password page checks only
  whether `SMTP_HOST` is non-empty. A live probe (connect-and-tls)
  would be more accurate but would also turn the public login route
  into a per-render network-call surface — out of scope.
- **No "Forgot password is disabled" surface elsewhere.** The login
  page still renders the "Forgot password?" link unconditionally —
  clicking it lands on /login/forgot, which surfaces the SMTP banner.
  Hiding the link entirely would leak the SMTP_HOST state into the
  pre-auth bundle.
