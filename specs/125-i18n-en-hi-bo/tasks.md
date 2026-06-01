# Tasks 125

- [x] T1 → install next-intl ^4.13.0, define `apps/web/src/i18n/config.ts` with the three-locale registry + per-key Bhoti→English fallback
- [x] T2 → seed `en.json` (canonical), `hi.json` (full coverage), `bo.json` (full coverage with Bhoti renderings) under `apps/web/src/i18n/locales/`
- [x] T3 → wrap `(authenticated)/layout.tsx` in `NextIntlClientProvider`; read `user_prefs.uiLanguage` and apply `var(--deva)` when locale is `hi`
- [x] T4 → migrate Topbar, Sidebar, BottomTabs to async server components that call `getTranslations()` for label copy
- [x] T5 → extract `gate-form.tsx` client island; convert `gate/[slug]/page.tsx` to a server component with inline `NextIntlClientProvider` and translated title/tagline/footer
- [x] T6 → add `login/layout.tsx` that reads the `gml-locale` cookie + wraps with `NextIntlClientProvider`; migrate `login/page.tsx` to call `useTranslations()` for button labels; mount the new `LoginLanguagePicker` client island
- [x] T7 → translate the dashboard's greeting + What's next/Today + Confidentiality card headings as a proof-of-life slice
- [x] T8 → author all five spec-kit files and the 7+ assertion governance test under `tests/governance/test_125_i18n_en_hi_bo.test.mjs`; verify the existing 860-test suite still passes
- [ ] T9 (Run 11) → translation review pass with a Hindi + Bhoti reviewer; fill any visibly-thin keys (e.g. the gate footer Bhoti rendering uses Tibetan numerals — verify with a Ladakhi speaker before shipping to Leh)
- [ ] T10 (Run 11) → extend translated coverage to the Settings page form labels themselves; today only the language picker buttons are translated, the rest of /settings stays English
