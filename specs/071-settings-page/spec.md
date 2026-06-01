# Spec 071 — Settings page (user-scope)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 7 (Core pages)

## Overview

`/settings` — the persisted, server-rendered production version of the prototype's
client-only Tweaks Panel. Ports the *user-facing* slice of `LMS GML Frontend/forms.jsx::SettingsPage`
(lines 268-341), narrowed to the four sections the locked `user_prefs` schema can
actually back: **Display**, **Privacy**, **Language**, **Account**.

Per-user preferences are persisted via `PUT /api/user-prefs` (spec 024 already shipped
the route — this page is the UI that drives it). Initial values are pre-loaded
server-side from `user_prefs` for the current session and passed into a single
`'use client'` form component that handles change-tracking, optimistic UI, error
recovery, and the actual fetch call.

The Programme / Video pipeline / Notifications / Backups sections in the prototype
are **admin-scoped system settings** — those are out of scope here; they will be
folded into the admin-registry surface (spec 012) when a `system_settings` table is
introduced. None of those fields exist in the current schema, so the prototype's
admin-only sections deliberately are not ported.

## Functional Requirements

- **FR-001**: Route file `apps/web/src/app/(authenticated)/settings/page.tsx` exists,
  is a server component, has `export const dynamic = "force-dynamic"`, and gets
  the current session via `await auth()`. If no session, `redirect("/login")`.
- **FR-002**: Server-side, the page issues a single Drizzle query —
  `db.select().from(userPrefs).where(eq(userPrefs.userId, session.user.id))` —
  to obtain the initial preference row. If the user has no row yet, the page
  passes a defaults object (matches `DEFAULT_PREFS` in `/api/user-prefs/route.ts`)
  to the client form so the first PUT writes a fresh row via the API's existing
  upsert path.
- **FR-003**: Page header matches GML convention: kicker label `Settings` in
  small caps, `<h1>` `Your preferences` in `var(--serif)` at `26px`, subtitle in
  `var(--ink-3)` explaining "persisted to your account; applied on next page load".
- **FR-004**: Four `var(--card-hi)` SectionCards in a 2-column grid (`1fr 1fr`,
  `gap: 18`, collapses to single column on narrow viewports via fixed grid):
    1. **Display** — density (dense / regular / loose), font_scale (regular /
       large / xlarge), high_contrast (toggle), reduced_motion (toggle).
    2. **Privacy** — show_watermark (toggle, default-on; tooltip explains it
       affects video overlay opacity in the player).
    3. **Language** — ui_language pill picker (English / हिन्दी / བོད་ཡིག). Devanagari
       labels render with `var(--deva)` font-family (SM-7).
    4. **Account** — read-only email + role chip. Role uses the same color tokens
       as the topbar (saffron for admins, indigo for mentors, lichen for teachers,
       rust for observers).
- **FR-005**: A single `'use client'` form component
  (`apps/web/src/app/(authenticated)/settings/settings-form.tsx`) owns local
  state, runs `fetch("/api/user-prefs", { method: "PUT", body })` on change,
  shows a transient "Saved" pill on success and a red error banner on failure.
  Form is "save on field change" (debounced 400ms via setTimeout) — there is
  **no Submit button**; this matches the prototype's Tweaks Panel ergonomic.
- **FR-006**: Client form posts only the fields that changed since the initial
  payload (delta-PUT), reducing the audit-log noise to actual edits.
- **FR-007**: Auth + role gate: every authenticated user can see and edit their
  own preferences. There is no admin/RBAC restriction (these are user-private
  settings). The page is `redirect("/login")` for anonymous and otherwise renders.
- **FR-008**: SM-7: Hindi name rendering only happens here for the Language
  picker label "हिन्दी" — under `var(--deva)`. The user does not edit a Hindi
  name on this page; their name is shown only in the read-only Account row.
- **FR-009**: SM-9 (PII audit): `user_prefs` is **not** PII — it stores style
  choices. The `/api/user-prefs` PUT already records a `user_prefs.update`
  audit row (spec 024). No additional audit hook is needed from the page.

## Acceptance Criteria

| AC  | Mapped from | Verification |
|-----|-------------|--------------|
| AC-1 | JSX SettingsPage header (line 270-274) | Test asserts `Your preferences` + `var(--serif)` |
| AC-2 | 4 SectionCards in 2-col grid (line 275) | Test greps `Display`, `Privacy`, `Language`, `Account` labels |
| AC-3 | Density / font_scale / contrast / motion controls (FR-004) | Test asserts each enum value appears in form |
| AC-4 | Watermark toggle (FR-004) | Test asserts `show_watermark` / `Watermark` label |
| AC-5 | UI language picker w/ English+हिन्दी+བོད་ཡིག (FR-004) | Test asserts all three labels |
| AC-6 | Devanagari font scoped to Hindi label only (SM-7) | Test asserts `var(--deva)` only on Hindi span |
| AC-7 | Server-side fetch + `redirect("/login")` (FR-001) | Test greps `redirect("/login")` + Drizzle query |
| AC-8 | Posts to `/api/user-prefs` via PUT (FR-005) | Test greps `"/api/user-prefs"` + `method:` PUT |
| AC-9 | `export const dynamic = "force-dynamic"` | Test greps the literal |
| AC-10 | No hex colors — only CSS-var tokens | Test asserts no `#[0-9a-f]{3,6}` in src |

## Schema gaps / deviations

- The prototype's "System settings" panels (Programme, Video pipeline, Notifications,
  Backups & retention) need a yet-to-be-designed `system_settings` table. **Out of
  scope** for this spec; documented in `designDeviations`.
- The prototype's nav_style field exists in `user_prefs` but is **not surfaced** on
  this page — nav style is auto-selected by device shell (spec 026: mobile uses
  bottom-tabs, desktop uses sidebar). Including a picker would be misleading. The
  column stays in the schema for future use.

## Audit hooks

None added here. The shipped `/api/user-prefs` PUT route already records
`user_prefs.update` audit entries with a `keys` metadata array (spec 024). This
spec leans on that.

## Out of scope

- Programme-wide / admin "System settings" (deferred until `system_settings` lands).
- Theme picker (no `theme` column in `user_prefs`; would require schema change).
- FTUX seen-at editing UI (mutated automatically by the FTUX flow, not surfaced).
- Login security panel (password change is on `/account/security` — spec ships later).
