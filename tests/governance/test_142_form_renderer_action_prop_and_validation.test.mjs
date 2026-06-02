// Governance test for spec 142 — FormRenderer `action` prop + validation race.
//
// Closes two CRITICAL/HIGH findings from the Workflow Run 13 audit:
//
//   A. `apps/web/src/components/forms/FormRenderer.tsx` declared an `action`
//      prop but never wired it onto the `<form>` element. The forms-runner
//      page at `/forms/[slug]` plumbed `action={submitFormAction}` for the
//      server-action submit path but every click on Submit silently
//      no-op'd because the component only listened for `onSubmit`.
//
//   B. The submit handler had a validate-then-setError race on rapid
//      double-tap. Fix: use the local `errs` constant for the gate (already
//      did) and pin the submit button via `disabled={submitting}`, plus on
//      mobile early-return when `submitting` is already true.
//
// The mobile runner gets the same `action`/`onSubmit` discriminator so a
// future preview surface can mount it without bringing a server action.
//
// Three files are under audit:
//
//   1. apps/web/src/components/forms/FormRenderer.tsx (EDITED)
//      — wires `action` onto `<form>`, adds dev-mode both-set assertion,
//        tightens the validation gate and submit button.
//   2. apps/web/src/components/forms/MobileFormRunner.tsx (EDITED)
//      — adds the `onSubmit` prop and the same dev-mode assertion;
//        early-returns when `submitting` is true.
//   3. specs/142-form-renderer-action-prop-and-validation/
//      — all five spec-kit files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RENDERER_PATH = "apps/web/src/components/forms/FormRenderer.tsx";
const MOBILE_PATH = "apps/web/src/components/forms/MobileFormRunner.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const SPEC_DIR = "specs/142-form-renderer-action-prop-and-validation";

// ---------- Spec-kit + plan.md contract ----------

test("spec 142 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the FormRenderer action/validation spec`,
    );
  }
});

test("spec 142 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /FormRenderer\.tsx/,
    "plan.md must call out the FormRenderer.tsx edit",
  );
  assert.match(
    src,
    /MobileFormRunner\.tsx/,
    "plan.md must call out the MobileFormRunner.tsx edit",
  );
  assert.match(
    src,
    /none|zero/i,
    "plan.md MIGRATED: line must explicitly note no new migrations",
  );
});

// ---------- Fix A: `action` prop is now wired onto <form> ----------

test("spec 142 — FormRenderer destructures `action` in the component body", () => {
  const src = read(RENDERER_PATH);
  // The component signature must destructure `action` alongside `onSubmit`
  // so it can branch on which one was provided. Match the destructure
  // pattern inside the function arg block.
  assert.match(
    src,
    /export\s+function\s+FormRenderer\s*\(\s*\{[\s\S]*?\baction\b[\s\S]*?\}\s*:\s*FormRendererProps/,
    "FormRenderer must destructure `action` from its props",
  );
});

test("spec 142 — FormRenderer wires `action` onto the <form> element", () => {
  const src = read(RENDERER_PATH);
  // The previously-dead `action` prop must now reach the form. Match the
  // attribute on the <form> tag in the JSX return.
  assert.match(
    src,
    /<form\b[\s\S]*?\baction=\{action\}/,
    "<form> in FormRenderer must declare action={action} so the server-action submit path fires",
  );
  // The onSubmit handler must still be present — we run client-side
  // validation before the native POST, never instead of it.
  assert.match(
    src,
    /<form\b[\s\S]*?onSubmit=\{onFormSubmit\}/,
    "<form> in FormRenderer must keep onSubmit={onFormSubmit} for client-side validation",
  );
});

test("spec 142 — FormRenderer asserts in dev when both `action` and `onSubmit` are provided", () => {
  const src = read(RENDERER_PATH);
  // The assertion lives behind a NODE_ENV gate so production stays silent.
  assert.match(
    src,
    /process\.env\.NODE_ENV\s*!==?\s*["']production["']/,
    "FormRenderer must gate the assertion behind a NODE_ENV !== 'production' check",
  );
  // Both `action` and `onSubmit` checked together so we only warn when
  // both are actually set.
  assert.match(
    src,
    /action\s*&&\s*onSubmit/,
    "FormRenderer must check `action && onSubmit` for the both-set assertion",
  );
  // The error message must mention FormRenderer so a developer scrolling
  // the console can see which component complained.
  assert.match(
    src,
    /\[FormRenderer\]/,
    "FormRenderer's dev assertion message must be prefixed with [FormRenderer]",
  );
  // console.error (not warn / log) because this is a programmer mistake
  // that breaks production semantics.
  assert.match(
    src,
    /console\.error\(/,
    "FormRenderer must use console.error for the both-set dev assertion",
  );
});

// ---------- Fix B: validation race + submit button hardening ----------

test("spec 142 — FormRenderer's submit handler uses the LOCAL `errs` constant for the gate", () => {
  const src = read(RENDERER_PATH);
  // The local `const errs = validateAll(...)` line stays.
  assert.match(
    src,
    /const\s+errs\s*=\s*validateAll\(/,
    "FormRenderer must compute `const errs = validateAll(…)` synchronously",
  );
  // The gate decision must read from `errs`, never from `errors` (the
  // setState value that lives across renders and can be stale).
  assert.match(
    src,
    /Object\.keys\(errs\)\.length\s*>\s*0/,
    "FormRenderer's validation gate must read Object.keys(errs).length (LOCAL constant) not errors state",
  );
});

test("spec 142 — FormRenderer submit button is disabled on `submitting` and carries the test hook", () => {
  const src = read(RENDERER_PATH);
  // The button-level disable is the second half of the double-submit guard.
  assert.match(
    src,
    /disabled=\{submitting\}/,
    "FormRenderer's submit button must be disabled={submitting} to block double-clicks at the browser level",
  );
  // Stable testid for the governance suite to pin the disabled state on
  // future Playwright integration tests.
  assert.match(
    src,
    /data-testid="form-renderer-submit"/,
    "FormRenderer's submit button must carry data-testid='form-renderer-submit'",
  );
});

test("spec 142 — FormRenderer's submit handler sets `submitting` before any await and resets in finally", () => {
  const src = read(RENDERER_PATH);
  // `setSubmitting(true)` appears in the handler body.
  assert.match(
    src,
    /setSubmitting\(true\)/,
    "FormRenderer's submit handler must call setSubmitting(true) before any await",
  );
  // `setSubmitting(false)` lives inside a finally block so a thrown
  // server action / onSubmit doesn't lock the form forever.
  assert.match(
    src,
    /finally\s*\{\s*setSubmitting\(false\)/,
    "FormRenderer must reset setSubmitting(false) inside a finally block on the onSubmit path",
  );
});

// ---------- Fix C: MobileFormRunner discriminator + double-tap guard ----------

test("spec 142 — MobileFormRunner accepts both `action` and `onSubmit` props (discriminator)", () => {
  const src = read(MOBILE_PATH);
  // Both shapes must be declared on the props type so a future preview
  // surface can mount the mobile runner without a server action.
  assert.match(
    src,
    /action\?\s*:\s*\(formData:\s*FormData\)/,
    "MobileFormRunnerProps must declare an `action` prop of type (formData: FormData) => Promise<void> | void",
  );
  assert.match(
    src,
    /onSubmit\?\s*:\s*\(responses:\s*Record<string,\s*unknown>\)/,
    "MobileFormRunnerProps must declare an `onSubmit` prop of type (responses: Record<string, unknown>) => Promise<void>",
  );
});

test("spec 142 — MobileFormRunner asserts in dev when both `action` and `onSubmit` are provided", () => {
  const src = read(MOBILE_PATH);
  assert.match(
    src,
    /process\.env\.NODE_ENV\s*!==?\s*["']production["']/,
    "MobileFormRunner must gate its both-set assertion behind a NODE_ENV !== 'production' check",
  );
  assert.match(
    src,
    /\[MobileFormRunner\]/,
    "MobileFormRunner's dev assertion message must be prefixed with [MobileFormRunner]",
  );
  assert.match(
    src,
    /console\.error\(/,
    "MobileFormRunner must use console.error for the both-set dev assertion",
  );
});

test("spec 142 — MobileFormRunner.onSubmitClick early-returns when already submitting", () => {
  const src = read(MOBILE_PATH);
  // The race guard — re-entry while in flight is a no-op.
  assert.match(
    src,
    /if\s*\(\s*submitting\s*\)\s*return/,
    "MobileFormRunner's onSubmitClick must early-return on submitting (rapid double-tap guard)",
  );
  // Local `errs` for the gate, same pattern as desktop.
  assert.match(
    src,
    /const\s+errs\s*=\s*validateAll\(/,
    "MobileFormRunner must compute `const errs = validateAll(…)` synchronously",
  );
  // The submit-button still disables on submitting (unchanged from spec 133,
  // but we re-pin it here so a future refactor can't quietly drop it).
  assert.match(
    src,
    /disabled=\{submitting\}/,
    "MobileFormRunner's submit button must remain disabled={submitting} as the second half of the race guard",
  );
});

test("spec 142 — MobileFormRunner branches its submit path on `action` vs `onSubmit`", () => {
  const src = read(MOBILE_PATH);
  // The action branch — requestSubmit() against the hidden form is the
  // existing spec 133 wiring; we just need to make sure it's gated.
  assert.match(
    src,
    /if\s*\(\s*action\s*\)\s*\{[\s\S]*?formRef\.current\?\.requestSubmit\(\)/,
    "MobileFormRunner must wrap the requestSubmit() call inside an `if (action)` branch",
  );
  // The onSubmit branch — symmetric with desktop FormRenderer.
  assert.match(
    src,
    /await\s+onSubmit\(values\)/,
    "MobileFormRunner must call `await onSubmit(values)` on the client-callback path",
  );
});

// ---------- End-to-end: page passes action and renderer accepts it ----------

test("spec 142 — forms-runner page still passes action={submitFormAction} to both renderers", () => {
  // Sanity check on the page that the prop is still being plumbed. The
  // bug we fixed wasn't on the page side, but we want the gate to fail
  // loudly if a future refactor accidentally drops the prop.
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /<FormRenderer\b[\s\S]*?action=\{submitFormAction\}/,
    "/forms/[slug]/page.tsx must pass action={submitFormAction} to FormRenderer",
  );
  assert.match(
    src,
    /<MobileFormRunner\b[\s\S]*?action=\{submitFormAction\}/,
    "/forms/[slug]/page.tsx must pass action={submitFormAction} to MobileFormRunner",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 142 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [RENDERER_PATH, MOBILE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 142 — no new dependencies were introduced for the action/validation fix", () => {
  // The whole change lives in two existing .tsx files; nothing under
  // apps/web/package.json should have changed.
  const pkg = read("apps/web/package.json");
  assert.ok(!/react-hook-form/.test(pkg), "apps/web must not depend on react-hook-form");
  assert.ok(!/formik/.test(pkg), "apps/web must not depend on formik");
  assert.ok(!/final-form/.test(pkg), "apps/web must not depend on final-form");
});
