# Spec 136 — Mobile-aware login layout (Workflow Run 12 frontend parity — final)

## Why

The JSX prototype at `LMS GML Frontend/mobile-login.jsx` (169 LOC)
defines a mobile-specific login experience that the live Next.js
port at `apps/web/src/app/login/page.tsx` doesn't yet honour. Today
the same desktop two-pane (brand-left / form-right) layout renders
on every viewport. It functions on a phone but is cramped: the
brand panel collapses awkwardly, fields sit at 9px padding (too
small for thumb taps), the language picker hides in the corner,
and there's no visual marker that this is a programme sign-in
rather than a generic site.

The prototype's answer is a single-column shell with:

- a **full-bleed mountain hero** (saffron→indigo gradient + SVG
  silhouette) that anchors the page visually before any text;
- **large stacked inputs** (44px minimum touch target) for email
  and password;
- a **prominent "Sign in" CTA** that fills the form width;
- a **mode toggle** between password and magic-link sign-in;
- the **language picker as a horizontal pill row at the bottom**,
  EN / हिं / བོད་, sitting above the home-indicator inset so notch
  devices don't overlap it;
- a **programme footer** disclosure (audit + build version) so the
  field user sees they're inside the official LMS.

Spec 136 ports that layout into production code while keeping the
Auth.js Credentials + Nodemailer magic-link contracts unchanged —
no auth logic moves, only the rendering tree splits.

## What we ship

### 1. `apps/web/src/app/login/page.tsx` (EDITED)

The page becomes a **server component**. It:

- Imports `getDeviceType` from `@/lib/device` (server-only, reads
  the `gml-device` cookie set by the client `useDeviceType` hook
  with a UA-string fallback for first visits).
- Reads `await getDeviceType()` and branches:
  `device === "mobile" ? <MobileLogin /> : <DesktopLogin />`.
- Holds no other logic — the heavy lifting moves to the two
  client subcomponents below.

The route-segment layout (`./layout.tsx`) is unchanged. It still
supplies the `NextIntlClientProvider` keyed on the `gml-locale`
cookie, so both branches use `useTranslations()` the same way.

### 2. `apps/web/src/app/login/DesktopLogin.tsx` (CREATED)

A verbatim lift of the original `page.tsx` body, declared
`"use client"` and exporting a named `DesktopLogin` function. The
two-pane brand+form design, the `<svg>` mountain silhouette at
600×600, the prayer-flag accent, the `<Stat>` helper, and the
`LoginLanguagePicker` mounted at top-right all carry over
unchanged.

The spec 034 governance contract literals (`हिन्दी`, `Ladakhi`)
stay in this file inside the existing hidden `<span aria-hidden>`
so the source-text gate keeps passing.

### 3. `apps/web/src/app/login/MobileLogin.tsx` (CREATED)

New `"use client"` component. The visual structure mirrors the
prototype but the form contract is rewritten to use the real
Auth.js server action (no demo phone+OTP path).

Structure:

- **Top-level wrapper** with `paddingTop: env(safe-area-inset-top)`
  so the hero clears the iOS notch.
- **Hero block** (`data-testid="mobile-login-hero"`): the
  saffron→indigo gradient, the `viewBox="0 0 412 220"` mountain
  silhouette SVG with the two-ridge composition and sun disc, the
  GML wordmark + "Welcome back" + sign-in tagline.
- **Form block** (scrollable, `flex: 1`): the password / magic
  link mode toggle (`data-testid="mobile-mode-toggle"`), then
  either the password form or the `EmailLinkForm` from the
  existing co-located file. The email + password inputs carry
  `data-testid="mobile-email"` and `data-testid="mobile-password"`
  with `minHeight: 44` (Apple HIG) and `fontSize: 16` (iOS
  zoom-on-focus suppression). The primary "Sign in" button
  (`data-testid="mobile-signin-button"`) matches.
- **Footer disclosure** (`data-testid="mobile-login-footer"`):
  "Goldenmile programme · audited" + build version.
- **Language pill row** (`data-testid="mobile-language-row"`)
  anchored at the bottom with
  `paddingBottom: calc(12px + env(safe-area-inset-bottom, 0px))`
  so the home indicator on iPhones doesn't overlap. Three
  44×44 buttons: EN / हिं / བོད་. Each writes the `gml-locale`
  cookie and calls `router.refresh()` — the same contract as
  `LoginLanguagePicker`, inlined here so the row's geometry can
  be tuned independently.

The form action is the exact same `loginAction` from
`./actions.ts` that the desktop shell uses, so the auth, audit
log, rate-limit, and redirect story is identical across devices.

## Acceptance criteria

- `page.tsx` no longer carries the `"use client"` pragma.
- `page.tsx` imports `getDeviceType`, awaits it, and branches
  `device === "mobile"` to pick the right subcomponent.
- `page.tsx` imports `MobileLogin` and `DesktopLogin` from the
  co-located files.
- `MobileLogin.tsx` exists, declares `"use client"`, exports a
  named `MobileLogin` function.
- `MobileLogin.tsx` imports `loginAction` from `./actions` and
  wires it via `useActionState` — same contract as the desktop
  shell.
- `MobileLogin.tsx` imports `EmailLinkForm` from
  `./email-link-form` for the magic-link path.
- `MobileLogin.tsx` renders a hero with the mountain SVG
  (`viewBox="0 0 412 220"`) and the indigo gradient
  (`oklch(0.32 0.08 268)`).
- `MobileLogin.tsx` renders inputs with `minHeight: 44` and the
  data-testids `mobile-email`, `mobile-password`,
  `mobile-signin-button`, `mobile-mode-toggle`.
- `MobileLogin.tsx` renders the language pill row
  (`mobile-language-row`) with EN, हिं, and བོད་ buttons.
- `MobileLogin.tsx` references `env(safe-area-inset-bottom)` for
  notch / home-indicator clearance.
- `MobileLogin.tsx` renders the footer disclosure with the
  programme name + version.
- `DesktopLogin.tsx` exists, declares `"use client"`, exports a
  named `DesktopLogin` function, and preserves the spec 034
  literal contract (`हिन्दी`, `Ladakhi`).
- All five spec-kit files exist under
  `specs/136-mobile-login-layout/`.
- `tests/governance/test_136_mobile_login_layout.test.mjs`
  passes with twelve+ assertions covering the above.

## Non-goals

- **No auth logic change.** `loginAction`, the credentials
  provider, the magic-link Nodemailer path, and the `/dashboard`
  redirect are all unchanged.
- **No new env vars.** No new schema. No new dependencies.
- **No phone+OTP path.** The JSX prototype shipped a demo
  phone+OTP UI; the production port uses real email + password
  per spec 034 / 035. A future SMS-OTP spec would be additive.
- **No mobile-specific email-link form.** `EmailLinkForm` is
  already responsive — we reuse it inside the mobile shell so the
  Nodemailer contract stays single-sourced.
- **No drawer / bottom-sheet animation library.** The language
  picker is a static pill row, not a slide-up drawer — the
  prototype showed a drawer but a static row passes the same
  accessibility / touch-target tests with zero JS.
- **No keyboard focus trap.** This is a pre-auth page with two
  fields and three locale buttons; native browser tab order works
  fine without a roving tabindex.
