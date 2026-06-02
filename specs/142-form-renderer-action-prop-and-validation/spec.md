# Spec 142 — FormRenderer `action` prop + validation race (Workflow Run 13 audit closure)

## Why

Two CRITICAL findings surfaced in the Workflow Run 13 7-agent audit on the
shared form-render layer used by every feedback survey, observation form,
quiz, survey and checklist in the LMS.

### Finding A — `action` prop declared but ignored

`apps/web/src/components/forms/FormRenderer.tsx` declared an `action`
prop (added under spec 074) so the forms-runner page could plumb the
server action through:

```tsx
<FormRenderer action={submitFormAction} formId={…} slug={…} pairingId={…} />
```

But the component body destructured the other server-action helpers
(`formId`, `slug`, `pairingId`, `context`) and rendered them as hidden
inputs — and then never wired `action` onto the `<form>` at all. The
form was still listening to `onFormSubmit` (the client-callback path),
and because the forms-runner page didn't pass `onSubmit`, every click
on Submit hit `if (onSubmit) await onSubmit(values)` and silently fell
through to `setSubmitting(false)`. The user saw a "Submitting…" flash
and the page never navigated. The catalogue-link contract for
`/forms/[slug]?pairingId=…` was broken end-to-end and only the seeded
test-doubles in the test fixture kept the suite green.

This was a CRITICAL because it killed the primary submit path for
every feedback form in the LMS without throwing an error or logging
anything — pure silent failure.

### Finding B — validate-then-setError race on rapid resubmit

The same handler ran:

```ts
const errs = validateAll(schema.fields ?? [], values);
setErrors(errs);
if (Object.keys(errs).length > 0) return;
```

The local `errs` constant was correctly used for the gate, but the
button itself didn't pin `submitting` early enough — a screen-reader
user firing Submit via Enter could land a second event before the
async `await flushSave()` returned and the first `setSubmitting(true)`
re-render had a chance to commit. The second handler ran against the
old `errors` snapshot via the stale closure, and on the unlucky frame
ordering it could re-enter validation and the submit path twice. The
form-drafts row got double-cleared; the audit row was duplicated.

This was HIGH severity because the failure mode required a specific
race window — sample reports showed maybe 1 in 200 mobile submits
under bad-network conditions.

## What we ship

### 1. `apps/web/src/components/forms/FormRenderer.tsx` (EDITED)

- Wire `action` onto the `<form>` element: `<form action={action} onSubmit={onFormSubmit}>`.
  When `action` is set, the browser handles the native POST on Submit;
  `onFormSubmit` only runs client-side validation and toggles `submitting`.
- Discriminator: `action` XOR `onSubmit`. Wiring both at once would
  double-submit (callback runs AND FormData is POSTed). In dev mode,
  log `console.error` when both are set.
- Tighten validation gate to use the local `errs` constant (already
  did) AND guard the submit button via `disabled={submitting}`.
  Together they form the two halves of the double-submit guard: a
  second click on a disabled button does nothing at the browser
  level, and the local-errs gate handles the focus-stuck-but-not-yet-
  disabled window.
- `submitting` is set BEFORE the await/native-submit and reset in
  `finally` on the onSubmit path; on the action path the page itself
  unmounts on redirect or re-renders with errors, which is the
  natural reset.
- Add a `data-testid="form-renderer-submit"` on the submit button so
  the governance suite can pin its disabled state.

### 2. `apps/web/src/components/forms/MobileFormRunner.tsx` (EDITED)

- Add the `onSubmit?: (responses) => Promise<void>` prop to mirror
  FormRenderer's discriminator.
- Same dev-mode assertion as desktop when both `action` and
  `onSubmit` are set.
- `onSubmitClick` early-returns on `submitting` so a rapid
  double-tap can't re-enter, uses the local `errs` for the gate,
  and resets `submitting` in `finally` on the onSubmit path.
- Server-action path still uses `formRef.current?.requestSubmit()`
  against the hidden `<form action={action}>` block at the bottom
  of the component tree — unchanged from spec 133/149.

## Acceptance criteria

- `FormRenderer.tsx` renders `<form action={action} onSubmit={...}>`
  so the server-action submit path actually fires.
- `FormRenderer.tsx` includes a dev-mode `console.error` when both
  `action` and `onSubmit` are wired simultaneously.
- The submit handler uses the local `errs` constant for the validation
  gate (no stale `errors` state read).
- `setSubmitting(true)` is called before any await in the submit
  path; the submit button is `disabled={submitting}`.
- `setSubmitting(false)` runs in the `finally` block on the
  client-callback (`onSubmit`) path.
- `MobileFormRunner.tsx` accepts both `action` and `onSubmit` props
  (discriminated union) with the same dev-mode both-set assertion.
- `MobileFormRunner.tsx` early-returns when already `submitting`.
- All five spec-kit files exist under
  `specs/142-form-renderer-action-prop-and-validation/`.
- `tests/governance/test_142_form_renderer_action_prop_and_validation.test.mjs`
  passes with 8+ assertions covering the above.

## Non-goals

- **No schema change.** The audit doesn't fix what's persisted, only
  the client gate around it. The feedback_responses / form_drafts /
  audit_log shapes are untouched.
- **No new dependencies.** Pure DOM + React.
- **No migration.** The next migration index (0016) is reserved for
  a different spec in this run; spec 142 ships zero SQL.
- **No env contract change.** All assertions live in the React tree.
- **No FormRenderer API removal.** The `onSubmit` prop stays for
  admin form-builder previews and unit-test renderers; we just
  forbid combining it with `action`.
- **No new audit row.** The double-submit fix prevents duplicates
  but doesn't backfill or de-duplicate existing rows.
