# Spec 155 — Topbar language picker + forms-runner audience gate (Workflow Run 14 audit closure)

## Why

The Workflow Run 14 audit consolidated 16 medium-severity findings into 7
follow-up agents. This spec closes two of them:

1. **Topbar language picker is non-functional chrome.** The dropdown shipped
   in spec 027 renders three list items (English / हिन्दी / བོད་ཡིག) but has
   no `onChange` handler. Clicking does nothing. The summary button is also
   hardcoded to render the literal string `"EN"` regardless of the user's
   actual `user_prefs.uiLanguage` — so a Hindi-speaking mentor who set their
   locale on the /settings page still sees "EN" on every authenticated page.
   The picker promises a feature that the chrome doesn't deliver.

2. **Forms runner is open to any logged-in user regardless of audience.** The
   `/forms/[slug]` runner reads the slug, resolves it to a `feedback_forms`
   row, and renders. There is no check that the user's role matches the
   form's `audience` column (mentor / mentee). Concretely a `teacher` user
   can hit `/forms/baseline-mentor-1?pairingId=…`, start typing answers, and
   their drafts will land on the `form_drafts` table against a template they
   were never supposed to see. The submit path doesn't fix this — the
   server-action accepts the response just as readily.

Both findings are MEDIUM severity (no data-corruption path, no privilege
escalation by themselves), but they break the product's "the chrome you see
is the chrome that works" promise and they widen the audit surface for the
sister CRITICAL fixes shipped in Run 13.

## What we ship

### `apps/web/src/components/nav/LanguagePicker.tsx` (CREATED)

A small `"use client"` island that replaces the static `<details>` dropdown
the topbar shipped pre-spec. The picker:

- Receives `current: "en" | "hi" | "bo"` as a prop (the parent server
  component reads `user_prefs.uiLanguage` and threads the normalised value
  down via the `DesktopShell` → `Topbar` chain so the island never queries
  the DB itself).
- Renders the current-locale chip in its own script (`EN`, `हि`, `བོ`) so
  the active language is unambiguous at a glance.
- Each row is a real `<button>` with an `onClick` that fires a `fetch("/api/user-prefs", { method: "PUT", body: { uiLanguage } })` and on
  success calls `window.location.reload()`. The reload is deliberate: the
  `NextIntlClientProvider` is rooted at the authenticated layout above any
  router-mutable subtree, so `router.refresh()` would not pick up the new
  messages bundle on the first paint.
- Selecting the already-current locale is a no-op — no needless round trip,
  no reload flicker.
- Failure modes (4xx / 5xx from the API, network error) are surfaced through
  an inline `role="alert"` row that auto-clears on the next dropdown open;
  the pending state freezes the chip to `…` so the user can't double-fire
  the PUT.
- Closes on outside click (a sibling click handler that ignores anything
  inside the `<details>` element).

### `apps/web/src/components/nav/Topbar.tsx` (EDITED)

- New optional prop `locale?: Locale` (default `"en"`) — typed against the
  `Locale` re-export from `@/i18n/config`.
- The block that used to render the hardcoded `<details>` dropdown is
  replaced by `<LanguagePicker current={locale} ariaLabel={tLanguage("pickerLabel")} />`.
- The pre-existing `getTranslations("language")` call is retained for the
  ariaLabel; the native-script row labels live inside the island so the
  client bundle doesn't have to import the i18n config.

### `apps/web/src/components/shells/DesktopShell.tsx` (EDITED)

- New optional `locale?: Locale` prop on `DesktopShellProps`, threaded to
  `<Topbar locale={locale} />`. The mobile shell does not surface a topbar
  language picker (out of scope here — mobile chrome lives behind the
  `MobileShell` header / `BottomTabs` pair; a future spec can decide
  whether to ship a parallel switcher).

### `apps/web/src/app/(authenticated)/layout.tsx` (EDITED)

- Single-line change: `<DesktopShell ... locale={locale}>`. The layout
  already computed `locale = normalizeLocale(prefRow?.uiLanguage)` for the
  `NextIntlClientProvider` — we just pass the same value to the shell so
  the picker's "current" prop is the source of truth `user_prefs` has on
  record, not a stale guess.

### `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx` (EDITED)

- New helper `isAudienceAccessAllowed(audience, role)` + an explicit
  `AUDIENCE_ALLOWED_ROLES` table that maps each `feedback_audience` value
  to the closed set of `RoleName`s allowed to render the runner:
  - `audience === "mentor"` → `["mentor"]`
  - `audience === "mentee"` → `["teacher"]` (in this codebase the mentee IS
    the classroom teacher being mentored; see `mentor_pairings.mentee_user_id`)
  - `audience === "programme"` → `"any"` (defensive; not in the shipped
    enum but a future migration could add it, and a partially-typed form
    landing with this audience must not break the runner)
  - `audience === undefined / null` → allowed (defensive fallback)
- After the `feedbackForms` SELECT and before any draft / prior-response
  fetch, the runner calls `isAudienceAccessAllowed(form.audience,
  session.user.role)`. A mismatch:
  1. Fires `void recordAudit({ action: "form.access.denied",
     entityType: "feedback_form", entityId: form.id, metadata: { slug,
     requiredAudience, role } })`.
  2. Redirects to `/forbidden`.
- The audit is fire-and-forget by contract — `recordAudit` returns
  `Promise<boolean>` since spec 141 but the runner intentionally discards
  the boolean so a degraded audit channel cannot block the redirect (the
  worst-case behaviour stays "user is bounced to /forbidden even though
  the audit row didn't land", not "user reaches the form because the
  audit log was down").

## Acceptance criteria

- `apps/web/src/components/nav/LanguagePicker.tsx` exists, starts with
  `"use client"`, and exports a default React component.
- The component PUTs to `/api/user-prefs` with a JSON body shaped
  `{ uiLanguage }` and then reloads the document.
- `apps/web/src/components/nav/Topbar.tsx` accepts a `locale?: Locale`
  prop and renders `<LanguagePicker current={locale} ... />` in place of
  the previous hardcoded `<details>` block.
- The hardcoded literal `"EN"` no longer appears in `Topbar.tsx` (the chip
  is now derived from the locale prop inside the island).
- `DesktopShell` accepts and forwards the `locale` prop.
- The authenticated layout passes its already-computed `locale` value to
  `<DesktopShell>`.
- `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`:
  - Declares an `AUDIENCE_ALLOWED_ROLES` table mapping `mentor` → mentor,
    `mentee` → teacher, `programme` → "any".
  - Calls `isAudienceAccessAllowed(form.audience, session.user.role)` after
    the form fetch.
  - On mismatch, fires `recordAudit({ action: "form.access.denied", ... })`
    with `slug`, `requiredAudience`, and `role` in the metadata, then
    `redirect("/forbidden")`.
- All five spec-kit files exist under `specs/155-chrome-i18n-finish-and-forms-access/`.
- `tests/governance/test_155_chrome_i18n_finish_and_forms_access.test.mjs`
  passes with at least eight assertions covering the above.

## Non-goals

- **No schema change.** Both fixes are pure application logic. No new
  migration index is consumed (the migrations directory next-idx remains
  available for an actual DB-shape spec).
- **No new dependencies.** The picker uses native `fetch` +
  `window.location.reload()`; the audience gate uses the existing
  `RoleName` enum and `recordAudit` helper.
- **No mobile language picker.** Mobile chrome is the `MobileShell`
  header + `BottomTabs`; surfacing the switcher there is a separate
  product decision and a separate spec.
- **No retroactive cleanup of `form_drafts` rows that landed pre-fix.**
  The drafts table is per-user / per-template; pre-fix a teacher could
  have autosaved a draft against a mentor-only form. Those rows are
  harmless (no FK to a pairing) and will be cleaned up next time the
  template version rolls. A migration to delete them now would risk
  removing in-flight work from legitimate edge cases.
- **No new audit-action enum.** `audit_log.action` is `varchar(64)` since
  spec 021; `form.access.denied` slots into the dotted-snake convention.
- **No PR-comment surface for the language picker change.** The picker
  is internal chrome; the change does not affect the public API and does
  not need a changelog entry beyond this spec.
