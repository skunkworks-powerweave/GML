# 117 — Observation cycle completion flow

**Status:** in_progress · **Date:** 2026-06-02 · **Phase:** 11 (Frontend parity Tier B)

## Problem

Frontend-parity audit gap. The JSX prototype `LMS GML Frontend/observation-detail.jsx`
renders a complete observation cycle progression — five visible CTAs across
the pre/observer/post forms, the sign-off confirm modal, the "Add note"
button, and the lesson-video upload widget. Lines 60, 198, 256, 339 in the
prototype each fire local React state but never write to the backend; the
real Next.js page at `apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx`
ships only the read-only stepper plus form/evidence sidebars. Result: every
seeded cycle stays in `status='nominated'` forever — the funnel from
`nominated → pre_submitted → observed → post_submitted → complete` has no
moving parts behind it.

Six concrete clicks are broken:

1. **Submit pre-form** — teacher posts the pre-observation reflection.
2. **Submit observer-form** — observer posts the rubric ratings + notes.
3. **Submit post-form** — teacher posts the post-observation reflection.
4. **Sign off** — mentor closes the cycle; record locks for SM-1 audit.
5. **Add note** — mentor's free-text note on the cycle.
6. **Upload lesson video** — the upload widget must carry the cycle id so
   `video_submissions.context_type='observation_cycle'` + `.context_id=<cycleId>`.

Because all six surfaces live in the same `page.tsx`, a single agent owns
the wire-up to avoid file collision.

## Goal

Wire all six prototype CTAs to real, audited, role-gated server actions
(Next.js App Router "use server"). Each status transition is guarded —
the precondition (current cycle status) is checked atomically inside the
UPDATE, so a stale tab can't move the cycle backwards through the funnel.

## Non-goals

- No new `observation_signoffs` or `observation_notes` table. v1 reuses the
  existing `observation_cycles.remark` column for the mentor note and the
  audit log (`action='observation.signed_off'`) for the signed-by record.
  A dedicated multi-signature table is deferred behind a schema migration.
- No multi-note thread. v1 stores one mentor note per cycle in `remark`.
- No bilingual prompt strings on the inline forms. The JSON shape we write
  into `observation_forms.responses` is English-only; a follow-up i18n
  spec can add Hindi labels without a migration.
- No file-upload progress notifications. The `UploadProgress` widget
  (spec 045) already owns its tray UI; we only pass `contextType` +
  `contextId` props.
- No FormRenderer integration. The prototype's rubric-picker / textarea
  composition is rich, but v1 uses inline native `<textarea>` to keep the
  six surfaces self-contained on one page. Spec 074 / 077 already host the
  template renderer for a future redirect-based form runner.

## API contract — server actions

All five actions live at
`apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts`
and accept a `FormData` whose `cycleId` field carries the cycle uuid.

### `submitPreFormAction(formData)`

- Allowed roles: `teacher | observer | mentor | programme_admin | super_admin`
- INSERT `observation_forms(cycleId, kind="pre", schemaVersion="1", responses, submittedByUserId)`,
  `.onConflictDoNothing()` (idempotent on the `(cycle_id, kind)` unique index).
- Transition `observation_cycles.status` from `'nominated'` to `'pre_submitted'`.
- Audit `action='observation.pre_form.submitted'` with `entityType='observation_cycle'`,
  `entityId=cycleId`, metadata = `{ code, from: 'nominated', to: 'pre_submitted' }`.
- On precondition mismatch → redirect `?error=invalid_transition`.

### `submitObserverFormAction(formData)`

- Allowed roles: `observer | mentor | programme_admin | super_admin`
- INSERT `observation_forms(cycleId, kind="observer", ...)`.
- Transition `'pre_submitted' → 'observed'`.
- Audit `observation.observer_form.submitted`.

### `submitPostFormAction(formData)`

- Allowed roles: `teacher | observer | mentor | programme_admin | super_admin`
- INSERT `observation_forms(cycleId, kind="post", ...)`.
- Transition `'observed' → 'post_submitted'`.
- Audit `observation.post_form.submitted`.

### `signOffCycleAction(formData)`

- Allowed roles: `mentor | programme_admin | super_admin`
- Transition `'post_submitted' → 'complete'`.
- Audit `observation.signed_off` with metadata `{ code, from, to, signedByUserId, signedAt }`.
  The audit row IS the "signed by" record for v1.
- On precondition mismatch → redirect `?error=invalid_transition`.

### `addNoteAction(formData)`

- Allowed roles: `observer | mentor | programme_admin | super_admin`
- UPDATE `observation_cycles.remark` (reuses existing column).
- Audit `observation.note.added` with `{ code, length }`.
- Empty note → redirect `?error=empty_note`.

### Shared helper — `transitionCycleStatus(cycleId, from, to)`

Single guarded helper used by all four transitions. Performs an atomic
UPDATE … WHERE id = ? AND status = ? … RETURNING code. Zero rows → redirect
`?error=invalid_transition` (logical 409). The RETURNING value provides the
cycle code to the audit metadata without a separate SELECT.

## UI wiring

The page at
`apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx`
gains five interactive surfaces:

1. **Pre-form inline form** — visible only when `cycle.status === 'nominated'`.
2. **Observer-form inline form** — visible only when `cycle.status === 'pre_submitted'`.
3. **Post-form inline form** — visible only when `cycle.status === 'observed'`.
4. **Sign-off button** — visible in the page header only when
   `cycle.status === 'post_submitted'`.
5. **Add-note form** — always visible; if `remark` already populated, the
   textarea pre-fills with the current note and the button reads "Update note".
6. **`<UploadProgress contextType="observation_cycle" contextId={cycleId}/>`** —
   replaces the read-only "video evidence" placeholder.

Inline `error=invalid_transition` and `error=empty_note` banners are
rendered above the stepper when the query string carries them.

## Functional Requirements

- **FR-001**: New file `apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts`
  declares `"use server"` at the top and exports the five server actions plus
  `transitionCycleStatus` (private helper, not exported — used internally).
- **FR-002**: All five actions go through `requireRole(...)` from
  `@/lib/guards` with the role lists documented above.
- **FR-003**: All four transition actions call `transitionCycleStatus()` to
  flip status atomically with the precondition check inside the WHERE clause.
- **FR-004**: All five actions call `recordAudit({...})` from `@/lib/audit`
  best-effort (`void` prefix) so audit-insert failure never blocks the user.
- **FR-005**: Action audit names follow the dotted convention:
  `observation.pre_form.submitted`, `observation.observer_form.submitted`,
  `observation.post_form.submitted`, `observation.signed_off`, and
  `observation.note.added` — all `entityType='observation_cycle'`,
  `entityId=cycleId`.
- **FR-006**: Form inserts into `observation_forms` use `.onConflictDoNothing()`
  so a double-submit (status already transitioned but user clicked twice) is
  silently idempotent rather than a 500.
- **FR-007**: All five actions call `revalidatePath('/observation/' + cycleId)`
  and end with `redirect('/observation/' + cycleId)` so the form `action=`
  pattern works without a client component.
- **FR-008**: Page imports the five actions from `./actions` and renders
  each CTA as a native `<form action={...}>` with `<input type="hidden"
  name="cycleId" value={cycleId} />` — server-component-friendly, no `"use
  client"` boundary.
- **FR-009**: Pre/Observer/Post inline forms are gated on the current
  status — only one form visible at a time, matching the funnel.
- **FR-010**: Sign-off button is gated to `cycle.status === 'post_submitted'`
  and renders in the page header (matches prototype line 60).
- **FR-011**: Add-note textarea pre-fills with `cycle.remark ?? ''` and
  the button label flips between "Add note" / "Update note".
- **FR-012**: `<UploadProgress>` is mounted with `contextType="observation_cycle"`
  and `contextId={cycleId}`. Reuses the spec 045 component verbatim — no new
  upload code.

## Acceptance criteria

| AC | Verification |
|---|---|
| AC-1  | `actions.ts` exists, declares `"use server"`, exports the five actions |
| AC-2  | Each action calls `requireRole(...)` with the documented role list |
| AC-3  | Status transitions are atomic — single UPDATE with `eq(status, from)` in WHERE |
| AC-4  | Each transition action calls `recordAudit` with the correct dotted action name |
| AC-5  | `signOffCycleAction` audit metadata carries `signedByUserId` and `signedAt` |
| AC-6  | `addNoteAction` rejects empty notes (`?error=empty_note`) |
| AC-7  | `submitPreFormAction` inserts `kind="pre"`, post inserts `kind="post"`, observer inserts `kind="observer"` |
| AC-8  | All five actions revalidate + redirect back to `/observation/[cycleId]` |
| AC-9  | `page.tsx` imports `UploadProgress` and passes `contextType="observation_cycle"` + `contextId={cycleId}` |
| AC-10 | `page.tsx` shows the sign-off form only when `status === 'post_submitted'` |
| AC-11 | `page.tsx` shows the pre-form only when `status === 'nominated'` (and same gating for observer/post) |
| AC-12 | `error=invalid_transition` banner renders above the stepper |

## Schema gaps / deviations

- **No `observation_signoffs` table** — the schema is locked for this run.
  The audit log's `observation.signed_off` row (with `signedByUserId` and
  `signedAt` in metadata) is the v1 "signed by" record. A migration to add
  a dedicated table with separate teacher + mentor signature rows is
  deferred. Documented under `designDeviations`.
- **No `observation_notes` table** — v1 reuses the existing
  `observation_cycles.remark` column. Multi-note threads are deferred.
- **`observation_forms` reuse for templates AND submissions** — spec 077
  parked pre/post/observer *templates* on the canonical seed cycle
  `OBS-2026-001` using the existing responses jsonb. Real submissions for
  other cycles use the same table with the same `kind` enum; the
  `(cycle_id, kind)` unique index keeps them naturally idempotent. Honest
  re-use, not a new deviation.

## Audit hooks

- `observation.pre_form.submitted` — entityType `observation_cycle`
- `observation.observer_form.submitted` — entityType `observation_cycle`
- `observation.post_form.submitted` — entityType `observation_cycle`
- `observation.signed_off` — entityType `observation_cycle` (audit row IS
  the signoff record; metadata.signedByUserId carries the actor)
- `observation.note.added` — entityType `observation_cycle`

All routed through `recordAudit({...})` from `@/lib/audit`, fire-and-forget
(`void` prefix) so audit-insert failure never blocks the user-facing flow.

## Out of scope

- Bilingual labels on the inline form fields.
- Notification side-effects on sign-off (emails, WhatsApp dispatch). Spec
  070 handles inbox; cycle complete will surface there via the existing
  status filter.
- A dedicated "Sign-off" page that visualises both signatures with image
  attestations. JSX prototype's `SignBlock` component is decorative; v1
  treats the mentor click as the sign-off itself and lets future UX add
  the teacher-acknowledgement loop.
