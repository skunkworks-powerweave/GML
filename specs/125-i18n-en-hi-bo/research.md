# Research 125

Three design choices needed up-front.

(1) **Library pick: `next-intl` over alternatives.** Next.js 16 ships
with first-class support for `next-intl` (App Router, server
components, async `getTranslations`, client `useTranslations` hook,
`NextIntlClientProvider`). The competitive alternatives — `react-i18next`,
`react-intl`, `lingui` — all need extra wiring to work cleanly with
React Server Components, and `react-i18next` in particular has a
notorious "client-only" footgun where the namespace lookup runs in a
useEffect, flashing untranslated copy on first paint. `next-intl` resolves
on the server before HTML is streamed, so SSR is fully translated. Cost:
one runtime dependency (~12 KB gzipped).

(2) **Locale source of truth: `user_prefs.uiLanguage`, not URL prefix.**
Most i18n stacks favour URL prefixes (`/en/dashboard`, `/hi/dashboard`)
because they help SEO + cache keying. The GML LMS is internal-only —
no SEO concern — and serving the same URL to a user across devices
makes their existing bookmarks portable when they switch language. The
column has shipped since spec 024 with a `CHECK (ui_language IN
('en','hi','bo'))` constraint, so the data plane is already
trustworthy. The authenticated layout reads it; the gate page reads
it; the login page falls back to a pre-auth `gml-locale` cookie
because user_prefs is unreadable before sign-in.

(3) **Fallback strategy for Bhoti gaps: per-key fallback to English,
not the next-intl default of rendering the raw key.** When `bo.json`
omits a key, next-intl ordinarily renders `{key}` as a placeholder.
For Bhoti that would visibly break the chrome — the translators will
not have caught up to the developers' string-adding velocity. We
short-circuit this in `loadMessages()` by deep-merging the `en`
bundle into the resolved bundle before passing it to the provider, so
any missing key resolves to the English string instead of `{key}`.
A `console.warn` fires in development per missing key so gaps are
visible during translation work, silent in production.

## Why translate only chrome, not page bodies

The prototype's settings page is explicit: "Used for UI labels and
notifications. Content (lesson titles, observation notes) is not
auto-translated." The product team's stance is that mentor / observer
notes are the source of truth for the conversation between two
educators; auto-translating them via a generic model would either be
wrong (Hindi-only model on Bhoti input) or distort tone. So we draw
the line at the chrome (nav, action verbs, status labels, gate
prompts) and leave content untouched. This spec wires the line; a
future spec can extend translated coverage to specific content surfaces
if the team decides to.

## What we considered and rejected

- **i18next via `i18next-resources-to-backend`.** Lazier loading but
  the migration cost (refactoring every `useTranslation()` call site)
  outweighs the ~5 KB savings on first paint.
- **A custom `t(key)` helper backed by JSON.** Avoids the dependency
  but reinvents pluralisation, gendered fallbacks, ICU MessageFormat
  — not work that warrants the +1 maintenance burden.
- **Auto-detecting the browser's `Accept-Language` header on first
  login.** Sounds nice but biases towards English (the only language
  most Indian-region browsers ship with as a default) and erodes the
  picker's value as a deliberate product affordance. The picker stays
  the single source of truth.
