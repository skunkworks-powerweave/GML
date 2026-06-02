# Research 168

Four half-wired features get finished. Each one is a small design
choice masquerading as a coding task — the implementation is
mechanical once the design call is made. This research file documents
the design calls.

## (1) `getSystemSettings()` — React.cache vs middleware injection

Two viable patterns for fetching a singleton row that multiple server
components want to read in the same request:

- **`React.cache(...)` per-render memo.** Each server component that
  needs the row calls `await getSystemSettings()`. The first call
  hits Postgres; the rest of the render tree gets the cached
  Promise. Implicit dependency surface — a future component author
  doesn't need to know about plumbing.
- **Layout-level fetch + prop-thread.** The authenticated layout
  fetches the row once and threads it through context / props to
  every child. Explicit dependency surface but adds a context
  provider for one value.

We chose `React.cache(...)` because:
- The cache key is implicit (no args) — the function takes no
  parameters since there is only one row by design (the
  `system_settings_singleton` CHECK constraint).
- It mirrors the pattern in `chrome-counts.ts` (`loadNavCounts`,
  `loadUnreadNotifications`, `loadQueueDepth` are all cached the
  same way) so a future contributor reading either file recognises
  the shape.
- Prop-threading would force every consumer to plumb the value
  through props even when the immediate parent doesn't care — for
  example, the `/admin/page.tsx` header reads programmeName but
  every page in the (authenticated) route group would have to
  accept the prop. The cache version stays local to the file that
  actually needs the value.

Fail-shape: any thrown error returns `null`. We chose null over
"throw and let the page boundary catch it" because the consumers
already have natural fallback values (the schema defaults), so a
returned null is the smallest API surface that preserves the
"never blank the page" contract.

## (2) `recordAuditDedup()` — atomicity vs simplicity

The dedup contract is "one audit row per (action × userId × dedupKey)
inside the TTL window". Two implementations:

- **Atomic INSERT ... WHERE NOT EXISTS** via a single round-trip
  CTE. No race window — guaranteed exactly-one row per key per
  window. The query is also more expensive (a SELECT + INSERT in
  one transaction) and Drizzle's INSERT builder doesn't natively
  support WHERE NOT EXISTS, so we'd need raw SQL.
- **SELECT-then-INSERT race-tolerant.** Two separate calls. A tight
  burst of identical requests can each see "no match" and each
  insert their own row. A few duplicates per hour is fine.

We chose the race-tolerant shape because:
- The dedup target is `/repo/students` rendered in a user's browser
  — concurrent renders from one user are physically impossible (the
  browser awaits the previous render before issuing the next).
  Across users, the dedup key includes the userId, so two users
  searching for "mary" each get their own row anyway.
- The cost of the atomic version is a transaction + CTE — overkill
  for "best-effort log spam suppression".
- The race-tolerant shape lets the helper stay readable: SELECT,
  check the count, conditional INSERT. A future reader doesn't
  need to grok PostgreSQL's CTE-with-modification semantics.

The dedupKey lives at `metadata.__dedupKey` (a reserved field with
a double-underscore prefix) so it never collides with the caller's
own metadata keys. The SELECT uses `metadata ->> '__dedupKey'`
(jsonb text accessor) which Postgres can use the GIN index on
`metadata` for — fast for the common case of "look up by dedup key
under one action".

## (3) Notifications filter — empty array means "off" not "everything"

The `system_settings.notificationsEnabled` jsonb column is a string
array. Three values are possible:

- `null` / column missing — pre-bootstrap deployment OR loader
  failed. Fall back to counting every unread row (the pre-spec-128
  behaviour) so the bell never silently goes dark.
- `[]` — the admin has actively disabled every category. Should
  return 0.
- `["cycle.assigned", "video.transcoded"]` — filter to the listed
  kinds.

The edge case that traps a naive implementation is `[]`. If we
unconditionally do `inArray(notifications.kind, enabledKinds)` and
the array is empty, Drizzle generates `kind IN ()` which Postgres
rejects with a syntax error. So we short-circuit on `[]` → return
0 BEFORE the query.

The `null` case maps to "no filter" — `inArray` is added only when
`enabledKinds !== null && length > 0`. This is the same pattern the
forgot-password page uses for `SMTP_HOST`: a missing config value
falls back to the safest pre-feature behaviour.

## (4) Forgot-password — server vs client component

Spec 161 shipped the page as a single `"use client"` component
because it has form state, a fetch call, and a success view. Spec
168 wants to read `process.env.SMTP_HOST` at render time, which
requires the server.

Three options:

- **Read on server, render the form unconditionally, hide it via
  CSS / hidden div.** Won't work — the form is still mounted, the
  user could submit it via DOM inspection.
- **Read on server, expose to client via `NEXT_PUBLIC_`.** Leaks
  the SMTP_HOST state into the pre-auth JS bundle. An attacker
  can enumerate which deployments have SMTP configured by
  diffing the bundle.
- **Split into server-component shell + client-component island.**
  Parent is a server component that reads env and decides what to
  render; the form (with its useState / fetch / submitted view)
  is a separate `"use client"` file imported into the shell.

We chose the split. The parent (`page.tsx`) reads env and renders
either the banner or `<ForgotPasswordForm />`. The form
(`ForgotPasswordForm.tsx`) is verbatim from the previous version —
behavioural contract preserved byte-for-byte, no risk of
regressing the 429 surface or the success copy.

The /api/auth/forgot-password route is unchanged. An attacker
probing the API directly still gets 200 regardless of whether
SMTP_HOST is set, so the no-enumeration contract holds even when
the page surfaces the SMTP-unavailable banner.

## (5) Transcode-jobs banner vs hint-in-strip

The existing depth strip already shows "Live queue depth unavailable
(Redis unreachable)" when `loadDlqDepth()` returns null. The spec-
168 banner is a DUPLICATE signal — same information, more visible
location. Why?

- The strip is small and tucked above the filter pills. An operator
  scanning the page for "what's the active job count" can miss the
  in-strip hint and assume "0 active, 0 waiting, 0 failed".
- The banner is `role="alert"` so screen readers announce it on
  page load. A blind operator triaging a transcode incident on a
  phone needs to know up-front that the live depth is stale; an
  inline span is not announced.
- The banner explicitly anchors the operator's attention to the
  historical table below: "The historical job table below is still
  accurate." Without that nudge, an operator might assume the
  whole page is broken and reload, or — worse — give up and call
  the ops team.

The banner is a `role="alert"` div, not a `<dialog>`, because we
don't want it to steal focus. The operator should still be able to
click into the table; the banner is informational.

## (6) /repo/students dedup TTL choice — 3600s vs 60s

Two reasonable TTLs for the dedup window:

- **60 seconds.** Catches the "user types incrementally" case
  (every render inside one minute collapses to one row). Misses
  the "user comes back five minutes later and re-runs the same
  search" case.
- **3600 seconds.** One row per (user × query × hour). Catches both
  cases — a user typing incrementally AND a user revisiting the
  same query later in the session — at the cost of "two SEPARATE
  searches an hour apart look like one in the log".

We chose 3600s because the SM-9 audit log's intended consumer is
forensic ("did this admin look at learner X's data?"), not
behavioural ("how many times did they re-search?"). A forensic
investigator querying the log for "did admin Y search for
'kunzang'?" gets one row regardless of whether the search was a
one-off or a session-long activity — both are the same forensic
event. The 60s window would over-count.

A separate `learners.bulk_view` row still fires every render so
the page-render rate is captured at the lower granularity. The
dedup affects only the new `learners.search` action.
