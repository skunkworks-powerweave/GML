# Spec 125 — Real i18n (English / Hindi / Bhoti) — Workflow Run 10 frontend-parity

## Why

The JSX prototype renders three language picker buttons (EN / हिन्दी /
Ladakhi) on the login page (line 165) and inside the topbar (shell.jsx),
and the `user_prefs.uiLanguage` column has shipped since spec 024 — but
nothing in the live app actually *translates* anything when the user
picks Hindi or Bhoti. The picker saves a column value that no code
reads. The frontend-parity audit flagged this as a previously-dropped
feature; this spec revives it.

The user has explicitly asked for full prototype parity. Spec 125
wires `next-intl` as the translation runtime and migrates the global
chrome (topbar, sidebar, mobile bottom tabs, section gate, login
page, and a couple of dashboard headings) to translated copy. Page
bodies stay English — the prototype's intentional "chrome translates,
content doesn't" line is preserved.

## What this spec does

1. Adds `next-intl` ^4 as a runtime dependency to `apps/web`.
2. Defines the supported locales `["en", "hi", "bo"]` (Bhoti is the
   Tibetan-script Ladakhi register; "bo" is its ISO 639-1 code).
3. Ships three locale bundles under
   `apps/web/src/i18n/locales/{en,hi,bo}.json`. Each bundle seeds
   ~60 strings organised into 9 namespaces: `brand`, `nav`,
   `navSection`, `action`, `status`, `gate`, `dashboard`, `language`.
4. Wraps the `(authenticated)` route group with
   `NextIntlClientProvider`. The provider locale is read from
   `user_prefs.uiLanguage` per-request (default `en`).
5. Wraps `/login` and `/gate/[slug]` with their own route-segment
   layouts (or inline provider) because they live outside
   `(authenticated)`. A pre-auth `gml-locale` cookie carries the
   user's pick on login before `user_prefs` exists.
6. Migrates the Topbar (sign-out title + bell aria-label + language
   picker dropdown), the Sidebar (every nav row label + every
   section heading + the "Online · synced" status), the BottomTabs
   (every mobile tab label), the section-gate prompt (title,
   tagline, footer, button labels) and the login page (sign-in /
   welcome / password / magic link / forgot button labels) to call
   `useTranslations()` (client) or `getTranslations()` (server).
7. Migrates a small proof-of-life slice of the dashboard
   (greeting + "What's next" / "Today" / "Confidentiality" card
   headings) to translated copy.

## What this spec does NOT do

- **No content translation.** Lesson titles, observation notes,
  resource captions, form questions, audit-log rows etc. stay in
  whatever language they were entered. The prototype is explicit
  about this in `/settings`: "Content (lesson titles, observation
  notes) is not auto-translated." We preserve that line.
- **No URL-segment locale prefixes.** The site stays at `/dashboard`,
  not `/en/dashboard` / `/hi/dashboard` / `/bo/dashboard`. The locale
  is per-user state, not URL state, by product decision (one user one
  language; SEO is not a concern for an internal LMS).
- **No accept-language header sniffing.** The picker is the single
  source of truth.
- **No translation of every page.** Per the brief: nav + login +
  gate + a couple of dashboard headings only.

## Fallback strategy

Bhoti (`bo`) bundles fall back to English on a per-key basis when a
translation is missing. In `process.env.NODE_ENV === "development"`
the fallback emits a `console.warn` so translators can see gaps;
production stays silent. Hindi (`hi`) is fully seeded with no
expected fallback. English is the canonical source.

## Hindi font

`var(--deva)` (Noto Sans Devanagari) is already declared in
`globals.css`. When the resolved locale is `hi`, the authenticated
layout (and the login layout, and the section-gate page) apply
`fontFamily: var(--deva)` at the wrapper element level. The Sidebar's
language picker already used the `deva` className for the Hindi
label; that stays.

## Acceptance criteria

- `apps/web/package.json` lists `next-intl` ^4.
- `apps/web/src/i18n/config.ts` exports `SUPPORTED_LOCALES`,
  `DEFAULT_LOCALE`, `normalizeLocale`, `loadMessages`,
  `LOCALE_FONT_FAMILY`, `LOCALE_HTML_LANG`.
- `apps/web/src/i18n/locales/en.json` has at least 40 keys.
- `apps/web/src/i18n/locales/hi.json` and `bo.json` cover the same
  namespaces as `en.json`.
- `apps/web/src/app/(authenticated)/layout.tsx` reads
  `user_prefs.uiLanguage`, normalises it via `normalizeLocale`, loads
  messages via `loadMessages`, and wraps `children` in
  `NextIntlClientProvider`.
- `Topbar` / `Sidebar` / `BottomTabs` import from `next-intl/server`
  and resolve their copy via `getTranslations()`.
- `gate/[slug]/page.tsx` reads `user_prefs.uiLanguage` itself (it's
  outside the authenticated route group) and renders with the resolved
  locale. The page still routes through `verifyGate` and the form keeps
  its mono-font password input — spec 035's contract is preserved.
- `/login/page.tsx` keeps its `"use client"` shape and uses
  `useTranslations()` from `next-intl` (provider is supplied by
  `/login/layout.tsx`). Spec 034's contract is preserved
  (`useState<"password" | "magic">`, `["password", "magic"]`, etc.).
- `dashboard/page.tsx` calls `getTranslations("dashboard")` for its
  time-of-day greeting and the two right-column card headings.
- Five spec-kit files exist at `specs/125-i18n-en-hi-bo/`.
- `tests/governance/test_125_i18n_en_hi_bo.test.mjs` passes with at
  least 7 assertions covering all of the above.
