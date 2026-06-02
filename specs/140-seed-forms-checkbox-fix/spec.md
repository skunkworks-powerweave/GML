# Spec 140 — seed-forms checkbox kind fix (Workflow Run 13 audit closure, CRITICAL)

## Why

A 7-agent code audit (Workflow Run 13) flagged a CRITICAL silent-data bug
in the form-seed pipeline. The mentor-audience feedback seed at
`packages/db/src/scripts/seed_forms_mentor.ts` declared its local
`FieldKind` type with the literal `"checkboxes"` (plural), and emitted
form-field rows whose `kind` property was the same plural literal.

`FormRenderer.tsx` (spec 072) and `MobileFormRunner.tsx` (spec 133) both
dispatch on the singular `field.kind === "checkbox"`. The plural
`"checkboxes"` never matches any branch in the renderer's `if/else if`
ladder, so every multi-select field in the seeded mentor forms (e.g.
the `expertise_areas` field in the mentor baseline form) fell through
to the final text-input fallback. A mentor opening the baseline form
saw a single-line text input where the spec promised a checkbox group;
their multi-select intent was lost on submit (the value was coerced to
the empty string and the form treated the question as effectively
unanswered).

The fix is a one-character rename — `"checkboxes"` → `"checkbox"` — at
the type declaration and at every field row in
`seed_forms_mentor.ts`. To prevent the same drift from re-emerging in
the other three seed scripts that ship in the same orchestrator
(`seed_all.ts` from spec 104), each seed now declares a canonical
field-kind allow-list and runs a runtime guard at module load that
warns and skips any row whose field-kind is not in the canonical
renderer set `{text, textarea, select, radio, checkbox, number, date,
likert, rating}`.

The remaining three seeds (mentee, observation, misc) use their own
per-file vocabulary that the dedicated audience-specific renderers map
to canonical kinds at render-time (mentee: `likert_5 → likert`,
`short_text → text`; observation: `scale → rating`; misc: `boolean`
and `boolean-group → checkbox`, `single-choice → radio`). The guard
in each of those three files validates against that mapping so a
future field added with an unmappable type is caught at seed time,
not silently shipped to production.

## What we ship

### 1. `packages/db/src/scripts/seed_forms_mentor.ts` (EDITED — bug fix)

- Rename the `FieldKind` type-alias member `"checkboxes"` to `"checkbox"`.
- Rename the single field-row `kind` literal `"checkboxes"` to `"checkbox"`
  (the `expertise_areas` field on `MENTOR_BASELINE`).
- Introduce a module-level `CANONICAL_FIELD_KINDS` const array
  (`text, textarea, select, radio, checkbox, number, date, likert,
  rating`).
- Introduce a module-level `assertCanonicalFieldKinds(forms)` helper
  that scans each form's `schema.fields[]`, warns and drops any form
  whose field-kind is outside the canonical set, and returns the
  filtered array. Invoked when building the `FORMS` array so any
  invalid entry is excluded before the insert loop runs.

### 2. `packages/db/src/scripts/seed_forms_mentee.ts` (EDITED — guard)

- Introduce `CANONICAL_FIELD_KINDS` plus a `MENTEE_TYPE_TO_CANONICAL`
  map (`likert_5 → likert`, `textarea → textarea`, `radio → radio`,
  `short_text → text`, `number → number`).
- Introduce `assertCanonicalFieldKinds(rows)` that walks every field's
  `type` and verifies it maps to a canonical kind; warns and drops
  any row with an unmappable type.
- Wire the guard at the `ROWS` declaration so an invalid entry never
  reaches the insert loop.

### 3. `packages/db/src/scripts/seed_forms_observation.ts` (EDITED — guard)

- Introduce `CANONICAL_FIELD_KINDS` plus an `OBSERVATION_TYPE_TO_CANONICAL`
  map (`text → text`, `textarea → textarea`, `scale → rating`).
- Introduce `assertCanonicalFieldKinds(templates)` that walks every
  field's `type` and verifies it maps to a canonical kind; warns and
  drops any template with an unmappable type.
- Wire the guard at the `TEMPLATES` declaration.

### 4. `packages/db/src/scripts/seed_forms_misc.ts` (EDITED — guard)

- Introduce `CANONICAL_FIELD_KINDS` plus a `MISC_KIND_TO_CANONICAL`
  map (`boolean → checkbox`, `boolean-group → checkbox`,
  `single-choice → radio`, `textarea → textarea`, `rating → rating`,
  `text → text`).
- Introduce `assertCanonicalFieldKinds(rows)` that walks every field's
  `kind` and verifies it maps to a canonical kind; warns and drops
  any row with an unmappable kind.
- Wire the guard at the `ROWS` declaration.

### 5. `tests/governance/test_140_seed_forms_checkbox_fix.test.mjs` (CREATED)

A scoped governance test that:

- Asserts none of the four `seed_forms_*.ts` files contain the literal
  `"checkboxes"` anywhere (regression gate for the original drift).
- Asserts every file references the singular `"checkbox"` somewhere in
  the canonical allow-list.
- Asserts the `FieldKind` (or `FieldType`) declaration in each file
  does not include `"checkboxes"`.
- Asserts each file declares a `CANONICAL_FIELD_KINDS` const and an
  `assertCanonicalFieldKinds` function (the runtime kind-validation
  guard).
- Asserts each file wires the guard at the array declaration so it
  runs at module load.
- Plus spec-kit completeness, plan.md CREATED/EDITED/MIGRATED
  contract, and the no-new-dependency check.

## Acceptance criteria

- `seed_forms_mentor.ts` contains zero occurrences of the literal
  `"checkboxes"`.
- The `FieldKind` union in `seed_forms_mentor.ts` includes
  `"checkbox"` and does not include `"checkboxes"`.
- All four seed files declare a `CANONICAL_FIELD_KINDS` allow-list
  matching the canonical renderer set.
- All four seed files declare an `assertCanonicalFieldKinds(...)`
  function and invoke it at the top-level array declaration so the
  guard runs at module load.
- The mentor seed's `expertise_areas` field on the baseline form is
  emitted with `kind: "checkbox"` so the FormRenderer's
  `CheckboxGroup` branch matches.
- `seed_all.ts` (spec 104) still imports all four seed scripts in
  unchanged order; the orchestrator is not edited by this spec.
- `tests/governance/test_140_seed_forms_checkbox_fix.test.mjs` runs
  green with eight or more assertions.

## Non-goals

- **No schema migration.** The fix is a string-rename in one seed
  file plus three defensive guards in sibling seeds; the
  `feedback_forms.schema` jsonb column shape is unchanged.
- **No renderer change.** `FormRenderer.tsx` and
  `MobileFormRunner.tsx` already dispatch on the canonical singular
  `"checkbox"` — they're correct; only the seed was wrong.
- **No re-seed runtime sweep.** Existing rows in the
  `feedback_forms` table that were seeded with the buggy plural
  remain in place; the operator runbook (spec 104 quickstart) is
  the single hand-edit to clean those up if the DB was already
  populated. A fresh seed run after this spec lands writes the
  correct singular value.
- **No vocabulary unification across seeds.** The audience-specific
  vocabularies (`likert_5`, `short_text`, `scale`, `boolean-group`,
  `single-choice`) remain as the dedicated renderers expect them;
  the guard's purpose is to catch unmappable drift, not to enforce
  a single vocabulary at seed time.
- **No new dependency.** Pure TypeScript + the existing logging
  surface (`console.warn`).
