# Spec 169 — Mobile and privacy polish (Workflow Run 16 post-audit hardening)

## Why

163 specs shipped. The 50-finding code audit closed in Run 15. A fresh
post-audit sweep flagged four polish items — small but real surface
gaps where the production UI either does the wrong thing on a typo'd
env value, leaks device-local state across user handoffs, fails to
mirror an existing mobile gesture pattern, or shows untranslated
chrome to non-English speakers. Each is a paper-cut, none is a bug
strictly speaking, but together they erode the "feels solid" floor
the LMS has otherwise earned.

This spec closes them as a single round so a future operator
walking the codebase doesn't have to grep three different specs for
the same Run-16 polish round.

## What we ship

### A. MobileQuizRunner swipe gestures

`apps/web/src/components/quiz/MobileQuizRunner.tsx` mirrors the
spec-139 pattern that MobileFormRunner already wires: a thumb-friendly
horizontal swipe on the quiz body advances or reverses one question.

  - Left swipe → next question (gated by the same "selection required"
    check the Next button enforces).
  - Right swipe → previous question (free move, clamped to step 0).
  - Swipes are ADDITIVE — the Previous / Next buttons remain
    unchanged so keyboard and screen-reader users have unchanged
    paths.
  - Submit always happens via the explicit button; a swipe never
    finalises the quiz.
  - Same 80px / 40px / 400ms thresholds as the form runner so a
    vertical scroll never registers as a swipe.

`useSwipe` is imported from `@/lib/use-swipe` (existing helper, no
new dependency). The root container picks up `ref={swipeRef}` and
`touchAction: pan-y`; `data-reduced-motion` hangs off the same root
as documentation for any future visual-feedback layer.

### B. QuickFind localStorage clear on sign-out

`apps/web/src/components/quickfind/QuickFind.tsx` stores recents at
`gml.quickfind.recent.<userId>`. On a shared device (a tablet in
Leh's RTT lab passed between teachers, an admin's laptop reused at
training) the recents from a previous account leak into the new
account's empty-state card.

The Topbar's user-pill sign-out form is a server-action form (the
button posts to a `next-auth` server signOut). Pre-spec-169 it had
no client-side hook, so we couldn't clear localStorage before the
form submitted.

Spec 169 adds:

  - An exported `clearAllQuickFindRecents()` helper in `QuickFind.tsx`
    that walks `window.localStorage`, removes every key matching the
    `gml.quickfind.recent.` prefix, and swallows failures (private
    browsing / quota / disabled storage cannot block sign-out).
  - A new `apps/web/src/components/nav/SignOutButton.tsx` 'use client'
    island wrapping the form's submit button. Its `onClick` invokes
    the helper synchronously, then lets the native form-submit run
    unchanged.
  - `apps/web/src/components/nav/Topbar.tsx` swaps the inline
    `<button type="submit">` for `<SignOutButton title={...} style={...}>`.

The clear is BEST-EFFORT and never throws. The form is still the
single source of truth for the sign-out itself.

### C. assertEnv() + UploadModal/HelpPanel WhatsApp gating

A typo'd `GML_WHATSAPP_NUMBER` (missing `+`, stray whitespace,
country prefix dropped) used to silently render a broken wa.me deep
link. The teacher would tap it, WhatsApp would open into an error
state, the teacher would conclude the LMS is broken.

`apps/web/src/lib/env.ts` (CREATED) exports `assertEnv()` which
validates three optional env vars:

  - `GML_WHATSAPP_NUMBER` against `/^\+\d{8,15}$/`
  - `GML_HELPDESK_PHONE` against the same E.164 pattern
  - `GML_HELPDESK_EMAIL` against a simple email regex (intentionally
    not RFC-5322-strict — we only catch fat-finger typos)

In production, any set-but-invalid value emits a SEVERE log line to
`console.error` and the validated value is returned as `null` so
consumers can hide the affordance. The function never throws —
soft-fail by design; a misconfigured helpdesk phone must not break
the dashboard.

`apps/web/src/app/(authenticated)/layout.tsx` calls `assertEnv()`
once per render (already React-cached by RSC's per-request render
loop). The result feeds:

  - The HelpPanel's helpdesk contact (the GML_HELPDESK_* values).
  - The videos and uploads pages' UploadModal prop (the
    GML_WHATSAPP_NUMBER value).

`apps/web/src/components/help/HelpPanel.tsx` and
`apps/web/src/components/video/UploadModal.tsx` each gain a local
`isUsableWhatsappPhone/Contact()` predicate. When the validated
phone is null OR the predicate rejects the format, the affected
WhatsApp section is REMOVED from the DOM rather than rendered as a
disabled stub. Email + in-app helpdesk-ticket paths remain visible
in HelpPanel; the direct-browser-upload path remains in UploadModal.

### D. i18n coverage extension

> **SUPERSEDED (2026-09 freeze, fix brief D_ui #8).** The keys below were
> never read by any page: `login/forgot`, `login/reset` and `forbidden`
> hardcode their copy, and neither they nor their form islands call
> `getTranslations` / `useTranslations`. The copy had also drifted from the
> product: `forbidden.locked` describes a 15-minute account lock that was
> deliberately removed; `smtp_unavailable` uses the SMTP framing
> `forgot/page.tsx` rejects in favour of `AUTH_EMAIL_ENABLED`; a single
> `forbidden.title` cannot express the page's four distinct reasons. The
> `login` and `forbidden` namespaces were deleted from en/hi/bo so the
> bundles stop advertising translations of three pages that have none.
> Localising those pages is still possible: wire the translator in the page
> first, then add keys whose copy matches what the page says. The
> nested-object support in `loadMessages` described below remains.

`apps/web/src/i18n/locales/en.json` gains two new namespaces and
keys for the password-reset (spec 161) and forbidden-page surfaces:

  - `login.forgot.title`, `login.forgot.email_label`,
    `login.forgot.submit_label`, `login.forgot.smtp_unavailable`
  - `login.reset.title`, `login.reset.new_password_label`,
    `login.reset.submit_label`, `login.reset.token_expired`
  - `forbidden.title`, `forbidden.locked`,
    `forbidden.smtp_unconfigured`, `forbidden.session_expired`,
    `forbidden.default`

`hi.json` mirrors with Devanagari translations. `bo.json` ships
empty-string placeholders for the same keys — the existing
`loadMessages` deep-fallback logic (extended in this spec to walk
nested objects and to treat an empty string as MISSING) renders
the English string and emits a `console.warn` for any empty bo
key when `NODE_ENV !== 'production'`.

`apps/web/src/i18n/config.ts` `loadMessages` is updated to handle
the new nested-object key shape (`login.forgot.title` lives at
`login.forgot.title` in the JSON tree). The function now recursively
merges target + fallback per leaf, preserving the spec-125 contract
that missing → English with a dev-only warn.

## Acceptance criteria

- `apps/web/src/components/quiz/MobileQuizRunner.tsx` imports
  `useSwipe` from `@/lib/use-swipe`, wires `onSwipeLeft` to a
  `goNext` helper and `onSwipeRight` to a `goPrev` helper, and
  attaches the swipe ref + `touchAction: pan-y` to the root
  container.
- `apps/web/src/components/quickfind/QuickFind.tsx` exports
  `clearAllQuickFindRecents()` which walks `window.localStorage`
  and removes the `gml.quickfind.recent.` prefix keys without
  throwing.
- `apps/web/src/components/nav/SignOutButton.tsx` exists as a
  'use client' island that calls `clearAllQuickFindRecents()` on
  click before letting the form submit.
- `apps/web/src/components/nav/Topbar.tsx` imports and renders
  `<SignOutButton>` inside the sign-out form.
- `apps/web/src/lib/env.ts` exists, exports `assertEnv()` and the
  `EnvSummary` / `EnvCheck` types, validates the three env vars
  with the specified regexes, and logs SEVERE in production for
  any set-but-invalid value WITHOUT throwing.
- `apps/web/src/app/(authenticated)/layout.tsx` imports and calls
  `assertEnv()` at render time and uses its return value for the
  helpdesk contact passed to HelpPanel.
- `apps/web/src/components/video/UploadModal.tsx` and
  `apps/web/src/components/help/HelpPanel.tsx` each define a
  local `isUsableWhatsappPhone/Contact()` predicate and use it to
  HIDE (not stub-disable) the WhatsApp affordance when the phone
  is missing or invalid.
- `apps/web/src/i18n/locales/en.json` declares both the `login`
  (with nested `forgot` + `reset` objects) and `forbidden`
  namespaces with the keys listed above.
- `hi.json` ships Devanagari translations for the same key tree;
  `bo.json` ships empty-string placeholders for the same key tree.
- `apps/web/src/i18n/config.ts` `loadMessages` walks nested
  objects, treats empty strings as missing, and emits a
  `console.warn` for each gap when `NODE_ENV !== 'production'`.
- All five spec-kit files exist under
  `specs/169-mobile-and-privacy-polish/`.
- `tests/governance/test_169_mobile_and_privacy_polish.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No new dependencies.** Every change reuses existing helpers
  (`useSwipe`, `recordAudit` not needed, `clearAllQuickFindRecents`
  is hand-written, `assertEnv` uses bare regexes, the i18n fallback
  is the spec-125 deep-merge plus nested handling).
- **No DB schema delta.** Migration idx unchanged.
- **No behavioural change to the desktop QuizRunner.** Spec 134 ports
  the mobile-runner from a JSX prototype; the desktop runner has its
  own (different) UX and is out of scope for this round.
- **No port of swipes to other mobile runners** beyond what
  MobileFormRunner already has (spec 139) and MobileQuizRunner now
  gains. MobileUploadRunner stays vertical-only — the upload UX has
  no per-step navigation to swipe between.
- **No translation work for bo.json beyond the empty placeholders.**
  The Ladakhi translator pass is a separate workstream; this spec
  only ensures the new keys are listed so the fallback path engages
  consistently. The `console.warn` is the visible signal during
  translation handoff.
- **No removal of the disabled-stub "Email admin (address not
  configured)" button.** That branch is harmless — a disabled mailto
  doesn't open a broken external surface, only a tooltip says the
  feature isn't available. We only HIDE the WhatsApp button because
  tapping a broken wa.me link launches an external app into an
  error state.
