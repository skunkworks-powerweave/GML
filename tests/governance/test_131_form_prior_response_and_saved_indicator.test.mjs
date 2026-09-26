// Governance test for spec 131 — Form prior-response prefill +
// saved-indicator top-right.
//
// Two files are under audit:
//
//   1. apps/web/src/app/(authenticated)/forms/[slug]/page.tsx
//      — adds a desc-ordered feedback_responses query keyed by
//        (formId, respondentUserId, pairingId), composes
//        initialResponses as draft ?? prior ?? {}, threads it
//        into the FormRenderer mount.
//   2. apps/web/src/components/forms/FormRenderer.tsx
//      — savedIndicator JSX moves to a top-of-card flex row
//        with marginLeft: "auto", error copy becomes
//        "Save failed — retrying…" (U+2026), gains
//        data-saved-indicator + aria-live="polite", reuses
//        the existing forceTick setInterval (no second timer).
//
// Plus the five spec-kit files under
// specs/131-form-prior-response-and-saved-indicator/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const RENDERER_PATH = "apps/web/src/components/forms/FormRenderer.tsx";
const SPEC_DIR = "specs/131-form-prior-response-and-saved-indicator";

test("spec 131 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the prior-response + saved-indicator spec`,
    );
  }
});

test("spec 131 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /forms\/\[slug\]\/page\.tsx/,
    "plan.md must call out the runner page in EDITED",
  );
  assert.match(
    src,
    /FormRenderer\.tsx/,
    "plan.md must call out the FormRenderer in EDITED",
  );
});

test("spec 131 — page.tsx imports desc from drizzle-orm", () => {
  const src = read(PAGE_PATH);
  // We need desc to order feedback_responses by submittedAt for the
  // "most-recent retake wins" semantics. Anything else (e.g., sql`...`)
  // would lose the type-safety the rest of the file relies on.
  assert.match(
    src,
    /import\s*\{[^}]*\bdesc\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "page.tsx must import desc from drizzle-orm alongside and + eq",
  );
});

test("spec 131 — page.tsx queries feedback_responses keyed by (formId, respondentUserId, pairingId)", () => {
  const src = read(PAGE_PATH);
  // The prefill query is the spec's load-bearing addition. All three
  // key columns must appear in the where() body.
  assert.match(
    src,
    /from\(feedbackResponses\)/,
    "page.tsx must select from feedbackResponses for the prior-response prefill",
  );
  assert.match(
    src,
    /eq\(feedbackResponses\.formId,\s*form\.id\)/,
    "prior-response where must filter by feedbackResponses.formId = form.id",
  );
  assert.match(
    src,
    /eq\(feedbackResponses\.respondentUserId,\s*userId\)/,
    "prior-response where must filter by feedbackResponses.respondentUserId = userId",
  );
  assert.match(
    src,
    /eq\(feedbackResponses\.pairingId,\s*pairingId\)/,
    "prior-response where must filter by feedbackResponses.pairingId = pairingId",
  );
});

test("spec 131 — page.tsx orders the prior-response query by submittedAt desc + limit 1", () => {
  const src = read(PAGE_PATH);
  // Most-recent retake wins; pick a single row to keep the query cheap.
  assert.match(
    src,
    /orderBy\(\s*desc\(feedbackResponses\.submittedAt\)\s*\)/,
    "prior-response query must orderBy desc(feedbackResponses.submittedAt)",
  );
  // The query must cap at one row — the renderer only consumes one
  // initialResponses object.
  assert.match(
    src,
    /\.orderBy\([^)]*\)[\s\S]{0,80}\.limit\(\s*1\s*\)/,
    "prior-response query must chain .limit(1) after the orderBy",
  );
});

test("spec 131 — page.tsx gates the prior-response query behind a truthy pairingId", () => {
  const src = read(PAGE_PATH);
  // Without a pairingId the form can't submit anyway (the action
  // redirects with ?error=missing_pairing), so skipping the query
  // saves a round-trip and keeps the pairingId variable typed.
  assert.match(
    src,
    /if\s*\(\s*pairingId\s*\)\s*\{[\s\S]*?from\(feedbackResponses\)/,
    "page.tsx must guard the prior-response query with `if (pairingId) { ... }`",
  );
});

test("spec 131 — page.tsx composes initialResponses with draft ?? prior ?? {} precedence", () => {
  const src = read(PAGE_PATH);
  // The precedence rule is load-bearing: drafts beat prior, prior
  // beats blank. Nullish coalescing keeps the empty-but-present
  // draft case correct (empty draft still beats prior). The page
  // may layer this through an intermediate `baseResponses` (spec 130
  // adds a prefill pass on top), but the draft → prior → {} chain
  // must appear verbatim somewhere in the file.
  assert.match(
    src,
    /draftResponses\s*\?\?\s*priorResponses\s*\?\?\s*\{\}/,
    "page.tsx must contain the literal `draftResponses ?? priorResponses ?? {}` chain so draft beats prior beats blank",
  );
  // The composed value is what FormRenderer must receive.
  assert.match(
    src,
    /initialResponses=\{initialResponses\}/,
    "FormRenderer mount must consume the composed initialResponses variable (no inline ternary)",
  );
});

test("spec 131 — FormRenderer renders savedIndicator in a top-of-card flex row", () => {
  const src = read(RENDERER_PATH);
  // The indicator's container must carry the data-saved-indicator hook
  // so governance + future tests can locate it without scraping CSS.
  assert.match(
    src,
    /data-saved-indicator/,
    "FormRenderer must mark the saved-indicator container with data-saved-indicator",
  );
  // marginLeft: "auto" is what pushes it to the right of the flex row.
  assert.match(
    src,
    /data-saved-indicator[\s\S]*?marginLeft:\s*["']auto["']/,
    "saved-indicator container must use marginLeft: 'auto' to sit on the right of the top-of-card row",
  );
  // aria-live="polite" so screen readers announce save state changes.
  assert.match(
    src,
    /data-saved-indicator[\s\S]*?aria-live="polite"/,
    "saved-indicator container must declare aria-live='polite' so save-state changes are announced",
  );
});

// Was: "uses the literal 'Save failed — retrying…' error copy". That copy was
// the defect -- nothing retried, and an expired session got the same words.
// The error branch now says what is actually happening (retrying, or sign in
// again, and that the answers are kept on the device); the messages live in
// draft-resilience.ts and are executed by tests/behaviour/ui-form-autosave.test.ts.
test("spec 131 — FormRenderer's error copy comes from the failure it describes", () => {
  const src = read(RENDERER_PATH);
  assert.match(src, /failureMessage\(saveFailure \?\? "error"\)/);
  assert.doesNotMatch(src, /Save failed — retrying…/, "a promise of a retry nothing performs");
  const helper = read("apps/web/src/components/forms/draft-resilience.ts");
  assert.match(helper, /sign in again/);
  assert.match(helper, /kept on this device/);
});

test("spec 131 — FormRenderer keeps 'Saved Ns ago' copy + var(--rust) error color", () => {
  const src = read(RENDERER_PATH);
  // The N-seconds-ago template literal is what gives the ticker its
  // live appearance. Spec 072's prior test asserts the same pattern;
  // we re-affirm here so a regression breaks 131 too.
  assert.match(
    src,
    /Saved \$\{seconds\}s ago/,
    "FormRenderer must render the 'Saved Ns ago' template literal so the ticker stays live",
  );
  // The error branch must paint the indicator in var(--rust); the
  // happy path uses var(--ink-3).
  assert.match(
    src,
    /saveState === "error"\s*\?\s*"var\(--rust\)"\s*:\s*"var\(--ink-3\)"/,
    "saved-indicator color must ternary on saveState — var(--rust) for error, var(--ink-3) for ok",
  );
});

test("spec 131 — FormRenderer reuses the existing 1 s forceTick setInterval (no new timer)", () => {
  const src = read(RENDERER_PATH);
  // Spec 131 must NOT add a second setInterval. Count occurrences —
  // there must be exactly one in the file (the spec-072 ticker).
  const intervals = src.match(/setInterval\(/g) ?? [];
  assert.equal(
    intervals.length,
    1,
    "FormRenderer must have exactly one setInterval — the existing forceTick ticker reused for live 'Saved Ns ago'",
  );
  // And the cleanup must still be wired so unmount is clean.
  assert.match(
    src,
    /return\s*\(\)\s*=>\s*clearInterval\(/,
    "FormRenderer must return clearInterval from the ticker useEffect to clean up on unmount",
  );
});

test("spec 131 — FormRenderer returns null savedIndicator when autosave is disabled", () => {
  const src = read(RENDERER_PATH);
  // No draftKey → autosaveEnabled is false → savedIndicator is null.
  // The top-of-card row must not render in that case.
  assert.match(
    src,
    /if\s*\(\s*!autosaveEnabled\s*\)\s*return\s+null/,
    "savedIndicator useMemo must return null when autosaveEnabled is false",
  );
  // The render guard at the top of the form card must consult
  // savedIndicator (not just schema.title) so callers without
  // a title still don't get an empty row.
  assert.match(
    src,
    /\(schema\.title \|\| savedIndicator\)/,
    "top-of-card row must render only when schema.title OR savedIndicator is truthy",
  );
});

test("spec 131 — FormRenderer does not expand its public-API props for the indicator", () => {
  const src = read(RENDERER_PATH);
  // The spec-072 contract baseline — schema / initialResponses /
  // onSubmit / draftKey / submitLabel — must still appear as the
  // leading destructured props. Spec 130 already added
  // formId/slug/pairingId/context; the spec-131 indicator is
  // internal and must not add a sixth public knob.
  assert.match(
    src,
    /export function FormRenderer\(\s*\{\s*schema,\s*initialResponses,\s*onSubmit,\s*draftKey,\s*submitLabel,/,
    "FormRenderer signature must keep the spec-072 props { schema, initialResponses, onSubmit, draftKey, submitLabel } as the leading destructured props",
  );
  // The indicator must not appear as a named prop — no
  // savedIndicator / showSavedIndicator / indicatorPosition
  // knob is permitted.
  assert.ok(
    !/\bsavedIndicator\s*[?:]/.test(src.split("FormRendererProps")[0] ?? src),
    "FormRenderer must not expose a savedIndicator prop — the indicator is internal-only",
  );
  assert.ok(
    !/showSavedIndicator|indicatorPosition/.test(src),
    "FormRenderer must not expose showSavedIndicator / indicatorPosition knobs — the indicator is internal-only",
  );
});

test("spec 131 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [PAGE_PATH, RENDERER_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
