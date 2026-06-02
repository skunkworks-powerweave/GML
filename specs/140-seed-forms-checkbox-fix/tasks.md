# Tasks 140

- [x] T1 → write the governance test (red) covering: each of the
  four `seed_forms_*.ts` files contains zero occurrences of the
  literal `"checkboxes"`; each file references the singular
  `"checkbox"` somewhere in its canonical allow-list; the local
  `FieldKind` / `FieldType` declaration in each file does not
  include `"checkboxes"`; each file declares a
  `CANONICAL_FIELD_KINDS` const and an
  `assertCanonicalFieldKinds` function; each file wires the
  guard at the array declaration so it runs at module load. Plus
  spec-kit completeness and plan.md CREATED/EDITED/MIGRATED
  contract. Run suite → red.
- [x] T2 → edit `packages/db/src/scripts/seed_forms_mentor.ts`:
  rename the `FieldKind` member `checkboxes` to singular
  `checkbox`; rename the `expertise_areas` field row's `kind`
  literal from plural to singular so the FormRenderer's
  `CheckboxGroup` branch matches; introduce
  `CANONICAL_FIELD_KINDS` allow-list and the
  `assertCanonicalFieldKinds(forms)` runtime guard; wire the
  guard at the `FORMS` array declaration.
- [x] T3 → edit `packages/db/src/scripts/seed_forms_mentee.ts`:
  introduce `CANONICAL_FIELD_KINDS`, `MENTEE_TYPE_TO_CANONICAL`
  mapping (`likert_5 → likert`, `short_text → text`, etc.), and
  the `assertCanonicalFieldKinds(rows)` guard; wire the guard at
  the `ROWS` declaration so any future field added with an
  unmappable type is caught at seed time.
- [x] T4 → edit `packages/db/src/scripts/seed_forms_observation.ts`:
  introduce `CANONICAL_FIELD_KINDS`,
  `OBSERVATION_TYPE_TO_CANONICAL` mapping (`scale → rating`,
  etc.), and the `assertCanonicalFieldKinds(templates)` guard;
  wire the guard at the `TEMPLATES` declaration.
- [x] T5 → edit `packages/db/src/scripts/seed_forms_misc.ts`:
  introduce `CANONICAL_FIELD_KINDS`, `MISC_KIND_TO_CANONICAL`
  mapping (`boolean → checkbox`, `boolean-group → checkbox`,
  `single-choice → radio`, etc.), and the
  `assertCanonicalFieldKinds(rows)` guard; wire the guard at the
  `ROWS` declaration.
- [x] T6 → author all five spec-kit files under
  `specs/140-seed-forms-checkbox-fix/`.
- [x] T7 → run the scoped governance suite
  (`pnpm test -- --test-name-pattern "spec 140"`) → green. Run
  the full suite to confirm no regression — the additions are
  inside four seed scripts that the existing test surface does
  not exercise at runtime.
- [ ] T8 (future) → add a Postgres CHECK constraint on
  `feedback_forms.schema -> 'fields'` that rejects rows whose
  field-kind values are outside the canonical set. Defers the
  guard from seed-time to insert-time so even hand-crafted
  inserts (admin Studio, direct SQL) are guarded. Out of scope
  here — the seed-time guard closes the audit finding; the
  belt-and-braces constraint is a follow-up.
- [ ] T9 (future) → unify the audience-specific vocabularies
  (`likert_5`, `short_text`, `scale`, `boolean-group`,
  `single-choice`) into the canonical renderer vocabulary, then
  collapse the four per-file mapping tables into a single
  imported constant. Out of scope; would require coordinated
  edits to the dedicated mentee / observation / misc renderers
  to stop reading the legacy aliases.
- [ ] T10 (future) → emit a structured metric (counter named
  `seed_forms.kind_dropped`) for each warn-and-skip event so a
  CI run that drops a row can be flagged in the metrics
  dashboard rather than relying on stdout grep. Out of scope;
  the visible-stdout pattern is sufficient for the manual
  operator runbook in spec 104's quickstart.
