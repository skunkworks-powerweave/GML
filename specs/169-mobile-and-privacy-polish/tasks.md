# Tasks 169

## A. MobileQuizRunner swipe

- [x] `apps/web/src/components/quiz/MobileQuizRunner.tsx`:
      import `useSwipe` from `@/lib/use-swipe`.
- [x] Extract `goNext` / `goPrev` helpers so swipe + button share one
      code path. `goNext` enforces the same disabled state as the
      Next button (selection required + not last screen).
- [x] Wire `useSwipe(goNext, goPrev)` on a `swipeRef` attached to
      the root container with `touchAction: pan-y`.
- [x] Inline `Spec 169` comment explaining swipe is ADDITIVE and
      submit-via-swipe is intentionally disabled.

## B. QuickFind localStorage clear

- [x] `apps/web/src/components/quickfind/QuickFind.tsx`: export
      `clearAllQuickFindRecents()` that walks localStorage by
      key-prefix and removes each `gml.quickfind.recent.*` entry.
      Try/catch swallows quota / private-browsing.
- [x] `apps/web/src/components/nav/SignOutButton.tsx` (CREATED): a
      'use client' wrapper around the form's submit button that
      calls the helper in onClick before letting the form submit
      proceed.
- [x] `apps/web/src/components/nav/Topbar.tsx`: import
      `SignOutButton`, replace the inline `<button type="submit">`
      inside the sign-out form with `<SignOutButton title style>`.

## C. assertEnv() + WhatsApp gating

- [x] `apps/web/src/lib/env.ts` (CREATED): `assertEnv()` validates
      `GML_WHATSAPP_NUMBER` / `GML_HELPDESK_PHONE` against
      `/^\+\d{8,15}$/` and `GML_HELPDESK_EMAIL` against a simple
      email regex. Returns an `EnvSummary` with per-field `EnvCheck`.
      In production, set-but-invalid emits `console.error` with the
      `[SEVERE][spec169]` prefix; never throws.
- [x] `apps/web/src/app/(authenticated)/layout.tsx`: import
      `assertEnv`, call it, use the validated phone / email for the
      `helpdeskContact` passed to HelpPanel.
- [x] `apps/web/src/app/(authenticated)/videos/page.tsx` +
      `apps/web/src/app/(authenticated)/uploads/page.tsx`: replace
      direct `process.env.GML_WHATSAPP_NUMBER` reads with
      `assertEnv().whatsappNumber.value`. Legacy
      `WHATSAPP_PHONE_NUMBER_ID` fallback preserved.
- [x] `apps/web/src/components/video/UploadModal.tsx`: declare
      `isUsableWhatsappPhone()` local predicate. Wrap the Path 1
      WhatsApp section in `{isUsableWhatsappPhone(phone) ? <...> : null}`.
- [x] `apps/web/src/components/help/HelpPanel.tsx`: declare
      `isUsableWhatsappContact()` local predicate. Gate the `waHref`
      build behind it. In `HumanHelpCard`, remove the disabled-stub
      branch for the WhatsApp row — hide the row entirely when
      `waHref === null`.

## D. i18n coverage

- [x] `apps/web/src/i18n/locales/en.json`: add `login.forgot.*`,
      `login.reset.*`, `forbidden.*` keys.
- [x] `apps/web/src/i18n/locales/hi.json`: mirror with Devanagari.
- [x] `apps/web/src/i18n/locales/bo.json`: mirror with empty-string
      placeholders.
- [x] `apps/web/src/i18n/config.ts`: extend `loadMessages` with a
      recursive walker that handles nested objects, treats empty
      strings as missing, and emits a dev-only `console.warn` for
      each gap.

## Spec-kit + governance

- [x] `specs/169-mobile-and-privacy-polish/{spec,plan,research,quickstart,tasks}.md`
- [x] `tests/governance/test_169_mobile_and_privacy_polish.test.mjs`
      with at least 10 assertions covering the above.

## Manual verification

- [x] `pnpm test -- tests/governance/test_169_mobile_and_privacy_polish.test.mjs`
      passes.
- [x] Full governance suite still passes (no regressions introduced).
