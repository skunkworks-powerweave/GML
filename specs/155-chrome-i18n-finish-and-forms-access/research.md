# Research 155

Five design decisions, each documented inline in the touched files and
expanded here.

## (1) Why a client island for the picker and not a server-side form POST

The pre-spec picker is a server-rendered `<details>` block; a "no-JS"
implementation would wrap each `<li>` in a `<form action={savePref}>` with
a hidden `uiLanguage` input and a submit button styled to look like the
list row. Three reasons we did not go that route:

- **The chrome must respond instantly.** A full server-action round trip
  on a 2G connection (the target audience in Ladakh) blocks the dropdown
  for the entire request duration. A `fetch` + `window.location.reload`
  feels identical from the user's perspective (both reload the document)
  but the visible "saving" state on the chip lands within one render
  cycle, not after a network round trip.
- **The picker is a sub-element of a `<details>`** — wrapping each row in
  a `<form>` would either nest forms (illegal) or require breaking the
  dropdown semantics. A client island keeps the markup clean.
- **The existing `/api/user-prefs` PUT endpoint already exists** (spec
  024) — we don't need a new server action when a stable JSON endpoint
  already accepts the exact payload shape `{ uiLanguage: "en"|"hi"|"bo" }`.

## (2) Why a full document reload and not `router.refresh()`

`NextIntlClientProvider` is mounted in `(authenticated)/layout.tsx` —
the messages bundle is a SSR-time computation that wraps every child
route. `router.refresh()` re-renders the route segment INSIDE that
provider, so the `useTranslations()` hooks still read against the OLD
messages bundle until the layout itself re-runs. The provider re-mount
only happens on a full document load.

We could refactor the layout to read `prefRow.uiLanguage` inside a child
that the router can refresh — but that would require either (a)
unmounting the entire `NextIntlClientProvider` tree on every navigation
(visible flicker), or (b) shipping a client-side i18n provider with
state that listens for a custom event from the picker. Both are more
invasive than `window.location.reload()` and neither buys the user any
visible benefit — the chrome flickers in either case.

The reload is also a known-safe escape hatch: if the picker ever races
the autosave on `user_prefs.ftuxSeenAt` (spec 123), the reload re-reads
both fields from the DB in one query, ruling out partial-write states.

## (3) Why `audience → role[]` not `audience → role` (singular)

The `AUDIENCE_ALLOWED_ROLES` map values are arrays even though the
shipped enum only needs a single role per audience. Three reasons:

- **`programme_admin` and `super_admin` should be able to preview ANY
  form** for QA / triage purposes. The current map locks them out
  alongside everyone else; a follow-up spec can widen this without
  changing the helper signature.
- **The `"any"` sentinel coexists cleanly with arrays.** Without the
  sentinel we'd have to special-case "every role" as `["teacher",
  "observer", "mentor", "programme_admin", "super_admin"]` which would
  rot the moment a sixth role appears.
- **Future audiences are open-ended.** The seed scripts already emit
  forms with audience-like context (`purpose: "schoolvisit"`); a future
  enum extension that adds `programme` or `observer` slots will need to
  enumerate which roles can see it. Arrays handle this without
  refactoring the call site.

## (4) Why log BEFORE redirect, not after

`redirect()` in the Next.js App Router throws a special
`RedirectError` that the framework catches and turns into a 307. If we
wrote:

```ts
redirect("/forbidden");
void recordAudit({ ... });   // unreachable
```

the audit row would never land. Putting the audit FIRST and trusting
the `void` discard (since `recordAudit` returns `Promise<boolean>`
since spec 141 but never throws — it catches its own DB errors) means
the audit reaches the queue before the throw, even on a degraded DB.

The audit is fire-and-forget by design — we explicitly do NOT `await`
it because a transient audit-log outage must not prevent the
`/forbidden` redirect. The user's experience is "I got bounced to
forbidden", with or without the row landing.

## (5) Why `mentee` → `["teacher"]` and not `["teacher", "observer"]`

The mentee-vs-teacher mapping is non-obvious from the audience name.
In this codebase:

- `feedback_audience` enum: `mentor | mentee` (schema/enums.ts)
- `mentor_pairings.mentee_user_id` references `users.id` where
  `users.role = 'teacher'`
- The /forms/baseline-mentee-1 form is filled by THE TEACHER reflecting
  on their own classroom practice — not by an observer

So `mentee` maps to ONLY `teacher`. An `observer` is a programme-side
role (audit, triage); they fill forms with `audience: mentor` (mentor
self-reflection forms about the teacher they're observing? Actually
no — mentor forms are filled BY mentors about themselves. Observer
forms are a separate category that the schema does not yet model
formally — they'd land under a `programme` or `observer` audience if
introduced).

The strict mapping is the safer default for the audit-closure spec —
a follow-up can widen the map if the product team decides observers
should be able to view (not fill, but view) mentee submissions for
triage.

## (6) Why no Playwright integration test

The fix lives in two places:

- A client island whose behaviour is "fetch then reload the page" — the
  reload is a hard refresh, which Playwright can observe but cannot
  meaningfully assert against (the test would just check that
  `window.location.reload` fires, which the source-shape pin in the
  governance test already covers).
- A server-side gate whose behaviour is "redirect on mismatch" — the
  governance test asserts the redirect call site exists; an integration
  test that boots the app, signs in as a teacher, navigates to a
  mentor-only form, and confirms the 307 would be a higher-fidelity
  contract but is also slower to run in CI.

The source-shape pin in the governance test is the LMS pattern across
all the audit-closure specs in Workflow Runs 12/13/14. Behaviour is
validated by the manual quickstart.
