# Tasks 155

- [x] T1 → write the governance test (red) covering:
  - `apps/web/src/components/nav/LanguagePicker.tsx` exists and starts
    with `"use client"`;
  - the picker PUTs to `/api/user-prefs` with a JSON body containing
    `uiLanguage`;
  - the picker calls `window.location.reload()` after a successful
    save;
  - `apps/web/src/components/nav/Topbar.tsx` mounts
    `<LanguagePicker current={locale} ... />` and accepts a
    `locale?:` prop;
  - the literal hardcoded `EN` token no longer appears in Topbar.tsx
    as a chip label;
  - `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx` declares
    `AUDIENCE_ALLOWED_ROLES` with `mentor → ["mentor"]` and
    `mentee → ["teacher"]`;
  - the runner imports `RoleName` and calls
    `isAudienceAccessAllowed(form.audience, ...)` after the
    `feedbackForms` SELECT;
  - on mismatch the runner fires `recordAudit({ action:
    "form.access.denied", entityType: "feedback_form", ... })` AND
    redirects to `/forbidden`;
  - all five spec-kit files exist under
    `specs/155-chrome-i18n-finish-and-forms-access/`.
  Run suite → red.

- [x] T2 → create `apps/web/src/components/nav/LanguagePicker.tsx` as a
  `"use client"` island that owns the EN / हि / བོ switcher. Receives
  `current: Locale` as a prop, PUTs `{ uiLanguage }` on selection,
  reloads the page on success, surfaces an inline error on failure,
  closes on outside click, no-ops when the user picks the
  already-current locale.

- [x] T3 → edit `apps/web/src/components/nav/Topbar.tsx`:
  - import `Locale` from `@/i18n/config` and `LanguagePicker` from
    `./LanguagePicker`;
  - add an optional `locale?: Locale` prop on `TopbarProps` (default
    `"en"`);
  - replace the hardcoded `<details><summary>EN</summary>...</details>`
    block with `<LanguagePicker current={locale} ariaLabel={tLanguage("pickerLabel")} />`.

- [x] T4 → edit `apps/web/src/components/shells/DesktopShell.tsx`:
  - import `Locale` from `@/i18n/config`;
  - add an optional `locale?: Locale` prop on `DesktopShellProps`;
  - forward it to `<Topbar locale={locale} />`.

- [x] T5 → edit `apps/web/src/app/(authenticated)/layout.tsx`:
  - one-line wire-through: `<DesktopShell ... locale={locale}>`. The
    layout already computes `locale = normalizeLocale(prefRow?.uiLanguage)`.

- [x] T6 → edit `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`:
  - import `RoleName` from `@gml/shared/auth/roles`;
  - declare `AUDIENCE_ALLOWED_ROLES` (mentor → ["mentor"], mentee →
    ["teacher"], programme → "any") and the
    `isAudienceAccessAllowed(audience, role)` helper;
  - after the `feedbackForms` SELECT and before any draft fetch, call
    the helper with `form.audience` and `session.user.role`; on
    mismatch fire `void recordAudit({ action: "form.access.denied",
    entityType: "feedback_form", entityId: form.id, metadata: { slug,
    requiredAudience, role } })` then `redirect("/forbidden")`.

- [x] T7 → author all five spec-kit files under
  `specs/155-chrome-i18n-finish-and-forms-access/`.

- [x] T8 → run the full governance suite. Confirm no regression — the
  new tests pin source shape; Topbar's pre-existing tests (027,
  125) reach into different lines (bell, sign-out title, sidebar
  translations) and don't care about the picker block.

- [ ] T9 (future, out of scope) → widen `AUDIENCE_ALLOWED_ROLES` so
  programme_admin and super_admin can preview any form for QA. Needs
  product sign-off — there's a privacy argument for keeping admins
  out of teacher self-reflection drafts.

- [ ] T10 (future, out of scope) → mobile language picker. The
  MobileShell header currently has no overflow / settings menu;
  decide whether to add a settings sheet (cleaner) or duplicate the
  picker as a topbar element (chrome bloat).

- [ ] T11 (future, out of scope) → swap `window.location.reload()` for
  a `router.refresh()` flow once the `NextIntlClientProvider` is
  refactored to read messages from a `cookies()`-driven cache
  (avoids the visible reload flicker on language change). Out of
  scope here because the refactor touches every authenticated route.
