# Spec 075 — form-catalog-mentor (Mentor-side feedback-form seed)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 8 Forms & quizzes (specs 072-080)

## Overview

Seeds the four MENTOR-audience feedback forms into `feedback_forms` so that the mentorship feedback
lifecycle (specs 056, 070, 071) has live form templates to render and validate against. The forms
are filled out by **mentors** about their **teachers** at four points in the quarterly cycle:

1. `baseline` (mentor) — initial bio + expertise + expected goals + meeting style
2. `progress_1` (mentor) — Q1 progress check
3. `progress_2` (mentor) — Q2 progress check (version "2" of the same kind shape)
4. `final` (mentor) — end-of-cycle holistic review

Schema shape (locked in spec 020 / `mentorship.ts`):
```
{ fields: [{ name, label, kind, required, options?, helpText? }] }
```

The script is **idempotent** — it checks for existing `(kind, audience, version)` rows before each
insert. Re-running is safe. No new dependencies, no new columns. Pairs with spec 076 (mentee-audience
seed) which will populate the matching mentee-facing forms.

## Functional Requirements

- **FR-001**: `packages/db/src/scripts/seed_forms_mentor.ts` is a runnable TS script
  (`tsx packages/db/src/scripts/seed_forms_mentor.ts`) that connects via `DATABASE_URL`.
- **FR-002**: Script inserts exactly four rows into `feedback_forms`:
  - (kind=`baseline`, audience=`mentor`, version=`1`)
  - (kind=`progress_1`, audience=`mentor`, version=`1`)
  - (kind=`progress_2`, audience=`mentor`, version=`2`)
  - (kind=`final`, audience=`mentor`, version=`1`)
- **FR-003**: Each row's `schema` JSONB conforms to the shape
  `{ fields: Array<{ name: string; label: string; kind: string; required: boolean;
  options?: string[]; helpText?: string }> }` and has 6–12 fields covering realistic
  mentor-perspective questions per the spec brief (bio, expertise multi-select, goals
  textarea, meeting-style radio for baseline; rating + narrative + concerns for progress;
  holistic rating + recommendation radio + achievements for final).
- **FR-004**: Idempotency — before each insert the script `SELECT`s by `(kind, audience, version)`
  using `eq()` AND `eq()` AND `eq()`; if a row exists, it logs `[seed] skipping…` and continues.
  The script never throws on re-run.
- **FR-005**: `DRY_RUN=true` env flag short-circuits writes, prints the would-insert plan,
  and exits cleanly with code 0 (same pattern as the Tier-0 `seed.ts`).
- **FR-006**: On success the script prints a summary line of the form
  `[seed-forms-mentor] DONE: inserted N, skipped M (4 mentor forms)` and exits 0.
- **FR-007**: Each form's `active` flag is `true`. The `version` column is text — `"1"` for
  three of the four forms, `"2"` for `progress_2` as specified in the brief.
- **FR-008**: Field `kind` values use the conventional form-renderer vocabulary
  (`text`, `textarea`, `checkboxes`, `radio`, `select`, `rating`, `number`, `date`).
  Multi-select expertise areas use `checkboxes` with `options`; meeting style and
  recommendation use `radio` with `options`; rating scales use `rating` with `options`
  representing the 1-5 scale labels.
- **FR-009**: Field `name` keys are lowercase snake_case stable identifiers
  (`bio`, `expertise_areas`, `expected_goals`, `preferred_meeting_style`,
  `mentee_progress_rating`, `narrative_reflection`, `concerns`, `holistic_rating`,
  `recommendation`, `achievements`, etc.) so `feedback_responses.responses` JSON keys
  remain stable across versions.
- **FR-010**: Script exits 1 on `DATABASE_URL` missing or on any unexpected drizzle error
  surfaced from the insert path, after closing the pool cleanly.

## Acceptance criteria

- AC-1: Running `tsx packages/db/src/scripts/seed_forms_mentor.ts` against a fresh DB
  inserts exactly 4 rows into `feedback_forms` with audience=`mentor`.
- AC-2: Re-running the script against a populated DB inserts 0 rows, skips 4, exits 0.
- AC-3: Setting `SEED_DRY_RUN=true` (or `DRY_RUN=true`) prints the plan and exits
  without writing.
- AC-4: Each inserted `schema.fields` array has between 6 and 12 entries, and every
  entry has the four mandatory keys (`name`, `label`, `kind`, `required`).
- AC-5: The `progress_2` form has `version='2'`; all other mentor forms have `version='1'`.
- AC-6: Governance test `tests/governance/test_075_form_catalog_mentor.test.mjs` passes —
  asserts the script file exists, references `feedbackForms`, uses the (kind, audience,
  version) idempotency check, names all four `feedbackKindEnum` values, and registers
  audience=`mentor` for each row.

## Out of scope

- Mentee-audience forms (spec 076).
- The form-renderer component (spec 077 / 078 — the renderer consumes the JSON shape).
- `feedback_responses` writes — the lifecycle in spec 056 already handles submit.
- Schema changes — `feedback_forms` shape is locked in spec 020.
