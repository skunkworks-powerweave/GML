# Tasks 142

- [x] T1 → write the governance test (red) covering: FormRenderer
  destructures `action` in its body AND wires it onto `<form>`;
  FormRenderer adds a `process.env.NODE_ENV` dev-mode `console.error`
  when both `action` and `onSubmit` are set; the submit handler uses
  the local `errs` constant for the validation gate; the submit
  button is `disabled={submitting}`; `setSubmitting(true)` runs
  before any await in the submit path; `setSubmitting(false)` is
  inside a `finally` block; MobileFormRunner accepts `onSubmit`
  in its props type with the dev-mode both-set assertion; the
  mobile `onSubmitClick` early-returns when `submitting` is true.
- [x] T2 → edit `apps/web/src/components/forms/FormRenderer.tsx`:
  destructure `action`, render `<form action={action} onSubmit=…>`,
  add the dev-mode both-set assertion, tighten the submit handler
  with a discriminator between server-action and client-callback
  paths, add `data-testid="form-renderer-submit"` on the button.
- [x] T3 → edit `apps/web/src/components/forms/MobileFormRunner.tsx`:
  add `onSubmit` to `MobileFormRunnerProps`, destructure it,
  add the dev-mode both-set assertion, add the `if (submitting)
  return` early-exit at the top of `onSubmitClick`, branch the
  submit path on `action` vs `onSubmit`.
- [x] T4 → author all five spec-kit files under
  `specs/142-form-renderer-action-prop-and-validation/`.
- [x] T5 → run the scoped governance suite
  (`pnpm test -- --test-name-pattern "spec 142"`) → green.
  Run the full suite to confirm no regression — the FormRenderer
  edit changes the submit semantics, but every existing test
  either uses `onSubmit` (preview path, unchanged) or doesn't
  assert on FormData posts (so the new action wiring is invisible
  to them).
- [ ] T6 (future) → typed discriminated union on the props so
  TypeScript catches the both-set case at compile time. Today's
  contract is a runtime assertion; a `XOR` type alias would push
  it to compile-time. Out of scope for the audit closure — the
  runtime check is sufficient for the field-deployed surface.
- [ ] T7 (future) → an integration test that boots Playwright,
  fills the form, double-taps Submit on a throttled connection,
  and asserts exactly one `feedback_responses` row was created.
  Out of scope — the governance suite is structural, the
  end-to-end check belongs in a Playwright phase we haven't
  scaffolded yet.
- [ ] T8 (future) → de-duplicate any existing double-submit
  rows in `feedback_responses` via a one-shot migration that
  groups by `(form_id, pairing_id, respondent_user_id)` and
  keeps the latest. We'd want to inspect prod data first to
  see how many of these actually exist.
