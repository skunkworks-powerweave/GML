# Plan 136

CREATED: `specs/136-mobile-login-layout/{spec,plan,research,quickstart,tasks}.md`, `apps/web/src/app/login/MobileLogin.tsx` (new mobile shell — hero + stacked form + language pill row + footer, all driving the existing loginAction server action), `apps/web/src/app/login/DesktopLogin.tsx` (verbatim lift of the original page.tsx body so the desktop UX stays pixel-identical and the spec 034 हिन्दी / Ladakhi governance literals stay in place), `tests/governance/test_136_mobile_login_layout.test.mjs`
EDITED: `apps/web/src/app/login/page.tsx` (drop the `"use client"` pragma; convert to a server component that awaits `getDeviceType()` from `@/lib/device` and dispatches to either MobileLogin or DesktopLogin)
MIGRATED: none — Auth.js Credentials + Nodemailer magic-link contracts unchanged across shells; the language picker still writes the existing `gml-locale` cookie; no schema additions, no env additions, no new dependencies, no new API routes
