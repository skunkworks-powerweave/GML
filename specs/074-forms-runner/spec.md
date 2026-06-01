# Spec 074 — Forms runner (`/forms/[slug]`)

**Status:** in_progress · **Date:** 2026-06-01 · **Phase:** 8 (Forms & quizzes)

## Overview

Authenticated runner for any registered `feedback_forms` template. The route is
`apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`, where `slug` is the
synthetic composite `${kind}-${audience}-${version}` (e.g. `baseline-mentor-1`,
`progress_2-mentee-2`, `schoolvisit-mentor-1`). The brief notes that the
`feedback_forms` table has no `slug` column today; the route walks the
`(kind, audience, version)` unique index to resolve the URL. This keeps the
schema locked and matches how the form catalogues (specs 075–078) link into the
runner.

The page is a server component (`export const dynamic = "force-dynamic"`). It
runs `auth()` from `@/auth` first and redirects any unauthenticated request to
`/login` — there is no role gate at the runner itself because `feedback_forms`
already carries an `audience` enum (mentor / mentee) which the catalogue pages
use to decide who sees which templates in their inbox. A teacher who navigates
directly to a `mentor`-audience form will still see the runner, fill it in, and
submit — the audience filter lives one layer up.

Once the form is resolved, the runner pulls any saved `form_drafts` row for the
current user against this template (`form_drafts.template_id = form.id AND
form_drafts.user_id = session.user.id`), then renders the `FormRenderer`
component (owned by spec 072 in the same fan-out) with the form schema, prior
draft responses, and a server-action `onSubmit`. The renderer carries the
"Saved 4s ago" autosave indicator and is the only client-side surface — the
runner itself stays a server component to minimise client JS and keep render
costs flat for the Ladakh-grade bandwidth target.

`onSubmit` is a `"use server"` action that

1. Validates the incoming `FormData` against the schema id list (drops unknown
   fields, keeps every advertised field — never throws on missing optionals).
2. Reads the `pairingId` (a hidden `<input>` posted by the renderer, sourced
   from the `?pairingId=` searchParam or the catalogue link that opened the
   runner) — this is the schema-mandated parent FK on `feedback_responses`.
3. Inserts the response row (`feedback_responses`) inside a transaction that
   also deletes the matching `form_drafts` row, so a refresh after submit shows
   the empty form rather than a stale draft.
4. Fires `recordAudit({ action: "form.submit", entityType: "feedback_response",
   entityId, metadata: { formId, kind, audience, version } })`.
5. Redirects to `/forms/[slug]/thanks` (a tiny server-rendered confirmation
   that uses the GML design tokens).

The thanks page is a sibling server component under the same `[slug]` route.

## Functional Requirements

- **FR-001**: Runner lives at
  `apps/web/src/app/(authenticated)/forms/[slug]/page.tsx`. Server component
  with `export const dynamic = "force-dynamic"`, no `"use client"` directive.
- **FR-002**: `auth()` from `@/auth` runs first. `redirect("/login")` when no
  session. Any logged-in user can run any form (audience filtering lives in
  the catalogue pages, per the brief).
- **FR-003**: `slug` is parsed as `${kind}-${audience}-${version}`. The route
  resolves it to a `feedback_forms` row via
  `kind=? AND audience=? AND version=? AND active=true`. If no match, render
  the page's not-found shell (Crimson Pro headline, "Form not found", a
  back-link to `/inbox`) — never throw to the global error boundary.
- **FR-004**: After resolution, the runner runs a second query against
  `form_drafts` filtered by `userId=session.user.id AND templateId=form.id`,
  selecting `responses` + `updatedAt`. Either zero or one row by the
  `form_drafts_user_template_uq` partial unique index.
- **FR-005**: Header block — uppercase eyebrow "Form · ${kind} · ${audience}",
  Crimson Pro headline derived from `form.schema.title` (with Hindi gloss in
  `var(--deva)` font when `form.schema.hindiTitle` is set; SM-7 conditional
  render), a 12px `var(--ink-3)` paragraph derived from `form.schema.description`
  if present, and a metadata strip showing version (`v${form.version}`,
  monospace pill) and the last-saved indicator if a draft was loaded (e.g.
  "Draft loaded · saved 4s ago" — exact rendering belongs to FormRenderer; the
  runner passes the `updatedAt` through).
- **FR-006**: Body block — single React node `<FormRenderer />` imported from
  `@/components/forms/FormRenderer` (spec 072). Props:
  `schema={form.schema}`, `initialResponses={draft?.responses ?? {}}`,
  `draftKey={{ templateId: form.id }}`, `action={submitFormAction}`,
  `pairingId={pairingIdFromSearchParams}`. The action is the server action
  defined in this same file.
- **FR-007**: `submitFormAction` is a `"use server"` async function declared at
  module scope. It accepts `(formData: FormData)`, re-runs `auth()` (defence in
  depth), pulls `formId`, `pairingId`, and the field map, inserts into
  `feedback_responses` with the response JSON, deletes the draft, and calls
  `recordAudit({ action: "form.submit", ... })`. Wraps both writes in a single
  `db.transaction(async (tx) => { ... })`.
- **FR-008**: After successful submit, the action redirects to
  `/forms/${slug}/thanks` via `redirect(...)` from `next/navigation`.
- **FR-009**: A confirmation page lives at
  `apps/web/src/app/(authenticated)/forms/[slug]/thanks/page.tsx` (sibling
  route, also server component, `force-dynamic`). It re-resolves the form by
  slug, renders a thank-you card with the title, and offers two CTAs:
  "Back to inbox" → `/inbox`, "Open another form" → `/inbox?filter=forms`.
- **FR-010**: SM-7 — Hindi gloss is conditionally rendered with `var(--deva)`
  and never emitted when null/empty (mirrors the convention on `/mentorship`
  and `/observation/[cycleId]`).
- **FR-011**: SM-9 — The runner does not touch the `learners` table and does
  not surface any learner PII; the audit hook fires on form.submit but does
  not include any free-text response payload (the metadata blob carries
  `formId`, `kind`, `audience`, `version` only).
- **FR-012**: Inline style with CSS-variable tokens (`var(--ink)`,
  `var(--paper)`, `var(--line)`, `var(--card-hi)`, `var(--r-3)`,
  `var(--serif)`, `var(--mono)`, `var(--deva)`, `var(--indigo)`). No raw hex
  colours. No Tailwind utility classes for the visual chrome.

## Acceptance criteria

| AC | Mapped from brief | Verification |
|---|---|---|
| AC-1 | Runner exists at `/forms/[slug]` | Governance test asserts file existence |
| AC-2 | Server component + `force-dynamic` | Test greps `export const dynamic = "force-dynamic"` and absence of `'use client'` |
| AC-3 | Slug parsed as `kind-audience-version` and resolved via `feedbackForms` | Test greps `feedbackForms` + the slug-parse helper |
| AC-4 | Form drafts loaded for `(user, template)` | Test greps `formDrafts` + `templateId` |
| AC-5 | `FormRenderer` mounted with schema/initialResponses/draftKey | Test greps `<FormRenderer` + `draftKey` |
| AC-6 | Server action `submitFormAction` with `"use server"` | Test greps `"use server"` and `submitFormAction` |
| AC-7 | Insert into `feedbackResponses` + audit `form.submit` | Test greps `feedbackResponses` + `"form.submit"` |
| AC-8 | Redirect to `/forms/[slug]/thanks` on success | Test greps the redirect template literal |
| AC-9 | Thanks page exists and links back to `/inbox` | Test asserts file + greps `/inbox` |
| AC-10 | Hindi gloss conditional with `var(--deva)` | Test greps `var(--deva)` and the `hindiTitle ?` ternary |
| AC-11 | Inline CSS-variable tokens, no hex | Test asserts no `#[0-9a-fA-F]{6}` and presence of `var(--serif)`, `var(--ink-3)` |
| AC-12 | Auth gate via `@/auth` | Test greps `from "@/auth"`, `auth()`, `redirect("/login")` |

## Schema gaps / deviations

- **No `slug` column on `feedback_forms`** — the runner synthesises the slug
  as `${kind}-${audience}-${version}` and resolves the URL through the existing
  `(kind, audience, version)` unique index. Documented in `designDeviations`.
- **`feedback_responses.pairing_id` is NOT NULL** — the schema mandates every
  response is bound to a `mentor_pairings` row, but the brief asks for a
  "public-ish" runner that any logged-in user can submit. The runner accepts a
  `?pairingId=` searchParam (also threaded through a hidden `<input>` inside
  FormRenderer's form). Catalogue pages (075–078) link in with the pairingId
  appended; manual entry without a pairingId fails at the action with a clear
  inline error rather than silently writing a malformed row. Documented in
  `designDeviations`.

## Out of scope

- The `FormRenderer` component itself — owned by spec 072 in this same Run-2
  fan-out. The runner imports it and trusts its contract.
- The autosave-to-`form_drafts` endpoint — owned by a sibling Phase 8 spec; the
  FormRenderer hits it directly via `fetch`.
- The form catalogue pages (075–078) — they own listing forms by audience and
  linking into this runner with the right pairing context.
- Multi-step / branching forms — the schema's `fields[]` array is a flat list;
  branching arrives with the SCORM phase (specs 081–086) if at all.

## Audit hooks

- `form.submit` (entity_type=`feedback_response`, entity_id=new response id,
  metadata={ formId, kind, audience, version }) — fired inside the server
  action, after the transaction commits, best-effort (failure of audit insert
  does not roll back the response).
