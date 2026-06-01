# Spec 072 — Generic FormRenderer + Autosave Draft Pipeline

**Status:** in_progress
**Date:** 2026-06-01
**Author:** GML LMS team
**Phase:** 8 — Forms & quizzes (keystone)
**Constitution Check:** PASS (no schema columns added; reuses existing `form_drafts` table; SM-7 honoured; SM-9 N/A because `learners` is not touched)

---

## Overview

Phase 8 wires the entire forms surface — feedback forms, observation pre/post reflections, surveys, checklists — onto **one** generic React component. This spec ships that component (`<FormRenderer>`) plus the autosave pipeline that backs the prototype's "Saved 4s ago" indicator.

The renderer is **schema-driven**: it accepts a `FormSchema` (the same JSONB blob already stored in `feedback_forms.schema`) and renders the appropriate input control for each field kind. The autosave layer debounces edits at 1 s, PUTs to `/api/form-drafts/[id]`, and on final submit calls the caller-provided `onSubmit` then DELETEs the draft.

Because every Phase-8 spec (073 admin-builder, 074 feedback-runner, 075 observation-runner, 076 survey, 077 checklist) consumes this renderer, every visual decision here is amortised. **This is the keystone — get it right.**

---

## User Stories

**US1 (Teacher — pre-observation reflection):**
As a teacher filling the pre-observation reflection 4 hours before my classroom session, I start typing on my laptop, my battery dies, I open the same form on my phone an hour later, and my responses are still there. I see "Saved 12s ago" in the lower-right of the form, confirming nothing was lost.
**Independent Test:** Fill 3 of 5 fields, wait 2 s (autosave triggers), reload — fields are pre-populated from the draft API.

**US2 (Mentor — post-observation feedback):**
As a mentor entering feedback after observing a teacher's lesson, I rate 8 dimensions on a 5-star scale, write a free-text "growth move" paragraph, and pick a one-word commitment from a dropdown. The renderer shows me the same 11px uppercase mono labels and red-asterisk required markers from the prototype.
**Independent Test:** `FormRenderer` with a schema containing `rating`, `textarea`, and `select` fields renders all three with correct visual styling per `forms.jsx`.

**US3 (Programme admin — composing a new survey):**
As an admin building the Term-2 endline survey in the admin form-builder (spec 073), every field-kind I'm allowed to add (`text`, `textarea`, `select`, `radio`, `checkbox`, `number`, `date`, `likert`, `rating`) renders correctly when I preview my draft schema via the renderer. The same component drives the preview AND the eventual teacher-facing fill experience.
**Independent Test:** Pass a schema with one of each kind to `<FormRenderer>` and assert all 9 render without errors.

**US4 (Compliance — abandoned draft cleanup):**
As compliance, when a teacher abandons a draft for >30 days, audit log shows `form.draft.save` events that stopped, and an admin can manually `DELETE /api/form-drafts/[id]?scope=template` to clear stale rows.
**Independent Test:** PUT then DELETE the same draft id; audit_log has matching `form.draft.save` and `form.draft.clear` rows.

**US5 (Future-developer — extending field kinds):**
As a developer adding a new field kind in Phase 11 (e.g. `file_upload` for the SCORM rollout), I extend the `FieldKind` union in one place and the renderer's switch picks it up without me touching every form-using page.
**Independent Test:** `kind` switch in `FormRenderer` handles each `FieldKind` variant; adding a new kind is a 1-file change.

---

## Functional Requirements

### Renderer (`apps/web/src/components/forms/FormRenderer.tsx`)

- **FR-001** `"use client"` component. Props:
  ```ts
  type FormRendererProps = {
    schema: FormSchema;
    initialResponses?: Record<string, unknown>;
    onSubmit: (responses: Record<string, unknown>) => Promise<void>;
    draftKey?: { templateId?: string; observationCycleId?: string };
    submitLabel?: string;
  };
  ```
- **FR-002** `FormSchema` shape:
  ```ts
  type FieldKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "number" | "date" | "likert" | "rating";
  type FieldOption = { value: string; label: string };
  type FormField = {
    name: string;
    label: string;
    kind: FieldKind;
    required?: boolean;
    options?: FieldOption[];   // for select/radio/checkbox
    helpText?: string;
    placeholder?: string;
    min?: number;
    max?: number;
    rows?: number;
    likertLabels?: [string, string, string, string, string]; // 5-point
    starsMax?: number; // default 5 for rating
  };
  type FormSchema = { title?: string; fields: FormField[] };
  ```
- **FR-003** Field rendering — each row has the **uppercase mono 11px label** in `var(--ink-3)` followed by the input. Required marker is a `*` in `var(--rust)` next to the label. `helpText` renders below the input at 11px in `var(--ink-3)`. Errors render at 11px in `var(--rust)` below `helpText`.
- **FR-004** Kind-specific rendering:
  - `text` / `number` / `date` → `<input>` with `border: 1px solid var(--line)`, radius `var(--r-2)`, padding `8px 10px`, font `var(--sans)`.
  - `textarea` → `<textarea>` (rows = `field.rows ?? 4`), same border/radius/padding.
  - `select` → `<select>` with options, leading "Choose…" placeholder.
  - `radio` / `checkbox` → list of `<label>` rows with input on the left.
  - `likert` → 5 segmented buttons labelled per `likertLabels` (defaults: Strongly disagree, Disagree, Neutral, Agree, Strongly agree). Selected = `var(--ink)` background, `var(--paper)` text.
  - `rating` → 1-to-`starsMax` star buttons. Visually mirrors prototype's `it.kind === "rating"` block: 38×38 buttons, mono digit, fill colour `var(--ink)` for selected.
- **FR-005** Validation runs on each change AND on submit. Required → empty value flags an error. `number` with `min`/`max` clamps the error message. Errors block submit.
- **FR-006** Autosave: when `draftKey` is provided, on every change a 1 s debounce timer fires and PUTs the current responses to `/api/form-drafts/{templateId|observationCycleId}?scope=template|cycle`. A "Saved Ns ago" indicator at the form footer updates every second via `setInterval`. Before first successful save, indicator reads "Not saved yet". On save error, indicator reads "Save failed — retrying" and the next change retries.
- **FR-007** Submit: validates first; if valid calls `onSubmit(responses)`; on success and if `draftKey` is set, DELETEs the draft so the row is freed for re-use.
- **FR-008** SM-7 (Hindi-name conditionality): the renderer does NOT special-case Hindi name fields directly, but any `text` field whose `name` ends in `_hi` or `_hindi` renders with `style={{ fontFamily: "var(--deva)" }}`. This keeps Devanagari rendering correct without forcing it on every field.
- **FR-009** Accessibility: each input has a `<label htmlFor={field.name}>`. Required fields have `aria-required="true"`. Error text has `role="alert"`.

### Draft helper library (`apps/web/src/lib/form-draft.ts`)

- **FR-010** Exports three async helpers:
  ```ts
  loadDraft(args: { templateId?: string; observationCycleId?: string }): Promise<Record<string, unknown> | null>;
  saveDraft(args: { templateId?: string; observationCycleId?: string; responses: Record<string, unknown> }): Promise<void>;
  clearDraft(args: { templateId?: string; observationCycleId?: string }): Promise<void>;
  ```
- **FR-011** Each helper builds the URL `/api/form-drafts/{id}?scope=template|cycle`. Exactly one of `templateId` / `observationCycleId` must be set; helper throws synchronously if both or neither are.
- **FR-012** `saveDraft` is fire-and-forget on the consumer side — it returns a resolved promise on 2xx, rejects on non-2xx. Network failures bubble up so the renderer can show "Save failed — retrying".

### Draft API route (`apps/web/src/app/api/form-drafts/[id]/route.ts`)

- **FR-013** Three handlers: `GET`, `PUT`, `DELETE`. All require an authenticated session; return 401 otherwise.
- **FR-014** `scope` query parameter is required: `template` or `cycle`. 400 if missing/invalid.
- **FR-015** `GET` returns the row's `responses` jsonb (or `null` if none).
- **FR-016** `PUT` body shape `{ responses: Record<string, unknown> }`, validated with zod. Upserts via:
  - `scope=template` → `ON CONFLICT (user_id, template_id) WHERE template_id IS NOT NULL DO UPDATE SET responses, updated_at`
  - `scope=cycle` → `ON CONFLICT (user_id, observation_cycle_id) WHERE observation_cycle_id IS NOT NULL DO UPDATE SET responses, updated_at`
- **FR-017** `DELETE` removes the row scoped to (user_id, template_id) or (user_id, observation_cycle_id).
- **FR-018** Every PUT writes audit `form.draft.save` (metadata: `{ scope, id, fieldCount }`). Every DELETE writes `form.draft.clear`. Best-effort — audit failure does NOT fail the user flow (matches existing `recordAudit` contract).
- **FR-019** `export const dynamic = "force-dynamic"` on the route module.

---

## Security Constraints

- **SC-001** Drafts are PII-bearing — they may contain teacher self-reflections. Scoped strictly to `session.user.id` on every read/write. The DB has partial-unique indices on `(user_id, template_id)` and `(user_id, observation_cycle_id)`, so no draft can be addressed without the owner.
- **SC-002** No schema changes — `form_drafts` is taken as-is from spec ~060 era.
- **SC-003** Audit on every save AND every clear, even though the row is private. Compliance can reconstruct who-saved-what-when.
- **SC-004** SM-7: Hindi-name fields use `var(--deva)` font; never marked required by the renderer itself (the schema-author still has to choose `required: false`).
- **SC-005** SM-9 N/A: this spec does NOT touch `learners`.

---

## Acceptance Criteria

1. `apps/web/src/components/forms/FormRenderer.tsx` exists, is `"use client"`, exports a named `FormRenderer` function.
2. The renderer's `kind` switch handles all 9 field kinds listed in FR-002.
3. Required-field validation works on both blur and submit; errors render in `var(--rust)`.
4. `apps/web/src/lib/form-draft.ts` exports `loadDraft`, `saveDraft`, `clearDraft`.
5. `apps/web/src/app/api/form-drafts/[id]/route.ts` exports `GET`, `PUT`, `DELETE` and `dynamic = "force-dynamic"`.
6. `pnpm test -- tests/governance/test_072_*.test.mjs` passes ≥ 5 assertions.

---

## Out of Scope (deferred)

- The admin form-builder UI → spec 073
- The feedback-form-runner page wiring → spec 074
- The observation-runner page wiring → spec 075
- Per-section navigation (multi-section forms) → spec 074 will wrap `FormRenderer` and add a section nav; the renderer itself handles **one section** at a time.
- File-upload field kind → Phase 11 (SCORM rollout)
- Field-conditional visibility ("show field B only if field A == X") → Phase 11
- Server-side schema validation against `feedback_forms.schema` (we trust the schema row here) — would need a schema-of-schemas; not worth it pre-launch
