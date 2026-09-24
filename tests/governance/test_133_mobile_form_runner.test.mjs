// Governance test for spec 133 — Mobile form runner (Workflow Run 12 final
// frontend parity closure).
//
// Closes the LMS GML Frontend/mobile-runners.jsx::MobForm affordance. Three
// files are under audit:
//
//   1. apps/web/src/components/forms/MobileFormRunner.tsx
//      — new "use client" component, one-field-per-screen layout,
//        progress dots, sticky Previous + Next + Submit, review
//        screen with Edit links, hidden <form action={action}> for
//        the server-action wire contract.
//   2. apps/web/src/components/forms/FormRenderer.tsx
//      — exports normalizeOptions, isHindiNameField, validateField,
//        validateAll so the mobile runner reuses the same validation
//        contract instead of re-implementing it.
//   3. apps/web/src/app/(authenticated)/forms/[slug]/page.tsx
//      — imports getDeviceType + MobileFormRunner, branches on
//        device === "mobile" while keeping the FormRenderer call-site
//        for desktop.
//
// Plus the five spec-kit files under specs/133-mobile-form-runner/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MOBILE_PATH = "apps/web/src/components/forms/MobileFormRunner.tsx";
const RENDERER_PATH = "apps/web/src/components/forms/FormRenderer.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const SPEC_DIR = "specs/133-mobile-form-runner";

test("spec 133 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile form runner spec`,
    );
  }
});

test("spec 133 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileFormRunner\.tsx/,
    "plan.md must call out the new MobileFormRunner component in CREATED",
  );
  assert.match(
    src,
    /FormRenderer\.tsx/,
    "plan.md must call out the FormRenderer edit (helper exports)",
  );
  assert.match(
    src,
    /forms\/\[slug\]\/page\.tsx/,
    "plan.md must call out the page-level device branch edit",
  );
});

test("spec 133 — MobileFormRunner.tsx exists and is a client component", () => {
  assert.ok(existsSync(resolve(root, MOBILE_PATH)), `${MOBILE_PATH} must exist`);
  const src = read(MOBILE_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "MobileFormRunner must declare 'use client' at the top — it owns useState + useEffect + useRef",
  );
  assert.match(
    src,
    /export function MobileFormRunner/,
    "MobileFormRunner must export a named MobileFormRunner function so server pages can import it",
  );
});

test("spec 133 — MobileFormRunner has the same prop shape as FormRenderer", () => {
  const src = read(MOBILE_PATH);
  // Every FormRenderer prop must be in the MobileFormRunner type so the
  // page can swap one for the other without changing the call-site.
  assert.match(src, /schema:\s*FormSchema/, "props must include schema: FormSchema");
  assert.match(
    src,
    /initialResponses\??:\s*Record<string,\s*unknown>/,
    "props must include initialResponses?: Record<string, unknown>",
  );
  assert.match(src, /draftKey\??:\s*DraftKey/, "props must include draftKey?: DraftKey");
  assert.match(
    src,
    /action\??:\s*\(formData:\s*FormData\)\s*=>\s*Promise<void>\s*\|\s*void/,
    "props must include action?: (formData: FormData) => Promise<void> | void — the server-action contract",
  );
  assert.match(src, /formId\??:\s*string/, "props must include formId?: string");
  assert.match(src, /slug\??:\s*string/, "props must include slug?: string");
  assert.match(
    src,
    /pairingId\??:\s*string\s*\|\s*null/,
    "props must include pairingId?: string | null",
  );
  assert.match(
    src,
    /context\??:\s*Record<string,\s*string>/,
    "props must include context?: Record<string, string> (spec 130 catalogue context)",
  );
});

test("spec 133 — MobileFormRunner reuses helpers from FormRenderer (no duplication)", () => {
  const src = read(MOBILE_PATH);
  // The four helpers must be imported, not re-defined. Drift between
  // mobile + desktop validation would mean a mobile draft could fail to
  // submit on desktop and vice versa.
  assert.match(
    src,
    /from\s+"\.\/FormRenderer"/,
    "MobileFormRunner must import helpers from ./FormRenderer",
  );
  assert.match(
    src,
    /isHindiNameField/,
    "MobileFormRunner must import isHindiNameField (single-sourced)",
  );
  assert.match(
    src,
    /normalizeOptions/,
    "MobileFormRunner must import normalizeOptions (single-sourced)",
  );
  assert.match(
    src,
    /validateField/,
    "MobileFormRunner must import validateField (single-sourced)",
  );
  assert.match(
    src,
    /validateAll/,
    "MobileFormRunner must import validateAll (single-sourced)",
  );
  // Sanity: the four helpers must not be re-declared as functions inside
  // the mobile file. A re-declaration would mean a copy-paste drift.
  assert.ok(
    !/function\s+normalizeOptions\s*\(/.test(src),
    "MobileFormRunner must NOT re-declare normalizeOptions (must import from FormRenderer)",
  );
  assert.ok(
    !/function\s+validateField\s*\(/.test(src),
    "MobileFormRunner must NOT re-declare validateField (must import from FormRenderer)",
  );
});

test("spec 133 — FormRenderer exports the four helpers MobileFormRunner relies on", () => {
  const src = read(RENDERER_PATH);
  // The four exports must be present at module level. Without these,
  // the mobile import above would fail to type-check.
  assert.match(
    src,
    /export function normalizeOptions/,
    "FormRenderer must export normalizeOptions",
  );
  assert.match(
    src,
    /export function isHindiNameField/,
    "FormRenderer must export isHindiNameField",
  );
  assert.match(
    src,
    /export function validateField/,
    "FormRenderer must export validateField",
  );
  assert.match(
    src,
    /export function validateAll/,
    "FormRenderer must export validateAll",
  );
});

test("spec 133 — MobileFormRunner reuses saveDraft from the form-draft helper", () => {
  const src = read(MOBILE_PATH);
  // Autosave pipeline must use the SAME PUT /api/form-drafts/[id] route
  // as desktop — drafts must be cross-device portable.
  // Through the autosave hook FormRenderer uses (draft-resilience.ts), which
  // calls saveDraft from @/lib/form-draft -- one pipeline, so a draft stays
  // portable across devices and both runners retry the same way.
  assert.match(src, /useDraftAutosave\(/, "MobileFormRunner must autosave through the shared hook");
  assert.match(
    read("apps/web/src/components/forms/draft-resilience.ts"),
    /import\s*\{[^}]*saveDraft[^}]*\}\s*from\s*"@\/lib\/form-draft"/,
    "the shared hook must import saveDraft from @/lib/form-draft",
  );
  assert.match(
    src,
    /AUTOSAVE_DEBOUNCE_MS\s*=\s*1000/,
    "MobileFormRunner must use the same 1000 ms debounce as the desktop renderer",
  );
});

test("spec 133 — MobileFormRunner enforces a 44px minimum touch target", () => {
  const src = read(MOBILE_PATH);
  // The Apple HIG / Material Design 44x44 floor must be expressed as a
  // module-level constant so the audit is one grep away.
  assert.match(
    src,
    /TOUCH_TARGET\s*=\s*44/,
    "MobileFormRunner must define TOUCH_TARGET = 44 (Apple HIG / Material floor)",
  );
  // The constant must actually be referenced — not declared and ignored.
  const minHeightUses = (src.match(/minHeight:\s*TOUCH_TARGET/g) || []).length;
  assert.ok(
    minHeightUses >= 3,
    `MobileFormRunner must reference TOUCH_TARGET as minHeight on at least 3 elements (got ${minHeightUses})`,
  );
});

test("spec 133 — MobileFormRunner honours safe-area insets for notch + home indicator", () => {
  const src = read(MOBILE_PATH);
  // iPhone notch (top) and home indicator (bottom) must be padded via
  // env() with a max() floor so non-notch devices still get spacing.
  assert.match(
    src,
    /env\(safe-area-inset-top\)/,
    "MobileFormRunner must reference env(safe-area-inset-top) for notch devices",
  );
  assert.match(
    src,
    /env\(safe-area-inset-bottom\)/,
    "MobileFormRunner must reference env(safe-area-inset-bottom) for the iPhone home indicator",
  );
  assert.match(
    src,
    /max\(\s*\d+px\s*,\s*env\(safe-area-inset/,
    "safe-area padding must be wrapped in max(<floor>, env(...)) so non-notch devices get a minimum inset",
  );
});

test("spec 133 — MobileFormRunner renders progress dots + Prev/Next/Submit testids", () => {
  const src = read(MOBILE_PATH);
  // The visible UI surface must carry the testids downstream e2e tests
  // and screen-reader audits can pin to. Each testid is also a smoke
  // signal that the visual contract from the JSX prototype landed.
  assert.match(
    src,
    /data-testid="mobile-progress-dots"/,
    "progress-dots container must carry a data-testid",
  );
  assert.match(
    src,
    /data-testid="mobile-form-prev"/,
    "Previous button must carry a data-testid",
  );
  assert.match(
    src,
    /data-testid="mobile-form-next"/,
    "Next button must carry a data-testid",
  );
  assert.match(
    src,
    /data-testid="mobile-form-submit"/,
    "Submit button must carry a data-testid",
  );
  assert.match(
    src,
    /data-testid="mobile-form-footer"/,
    "sticky footer container must carry a data-testid",
  );
});

test("spec 133 — MobileFormRunner renders likert + rating + review with their own surfaces", () => {
  const src = read(MOBILE_PATH);
  // Each kind-specific renderer is its own component; the testids let
  // a screen-reader audit confirm they actually mounted.
  assert.match(
    src,
    /data-testid="mobile-likert"/,
    "likert renderer must carry the mobile-likert testid",
  );
  assert.match(
    src,
    /data-testid="mobile-rating"/,
    "rating renderer must carry the mobile-rating testid",
  );
  assert.match(
    src,
    /data-testid=\{\s*`mobile-review-row-\$\{f\.name\}`\s*\}/,
    "review screen must render one row per field with the mobile-review-row-<name> testid",
  );
  assert.match(
    src,
    /data-testid=\{\s*`mobile-review-edit-\$\{f\.name\}`\s*\}/,
    "each review row must carry a mobile-review-edit-<name> testid on its Edit button",
  );
});

test("spec 133 — MobileFormRunner uses 16px input font to defeat iOS focus zoom", () => {
  const src = read(MOBILE_PATH);
  // Mobile Safari zooms the viewport on focus when the font-size on the
  // input is below 16px. The mobile runner ships 16px so the page
  // doesn't lurch. Desktop FormRenderer (13px) does not have this
  // problem because desktop browsers don't zoom on focus.
  assert.match(
    src,
    /fontSize:\s*16/,
    "MobileFormRunner must set fontSize: 16 on its inputs (iOS focus-zoom defence)",
  );
});

test("spec 133 — MobileFormRunner posts via hidden <form action={action}> for the server-action contract", () => {
  const src = read(MOBILE_PATH);
  // The wire contract MUST match desktop: __formId / __slug /
  // __pairingId / __ctx_<key> / field-name hidden inputs. The server
  // action in forms/[slug]/page.tsx reads exactly these keys.
  assert.match(
    src,
    /name="__formId"/,
    "hidden form must carry the __formId input the server action reads",
  );
  assert.match(
    src,
    /name="__slug"/,
    "hidden form must carry the __slug input the server action reads",
  );
  assert.match(
    src,
    /name="__pairingId"/,
    "hidden form must carry the __pairingId input the server action reads",
  );
  assert.match(
    src,
    /name=\{\s*`__ctx_\$\{k\}`\s*\}/,
    "hidden form must emit __ctx_<key> inputs for the spec 130 catalogue context",
  );
  // requestSubmit() is how we trigger the action without an enclosing
  // <form> around the visible controls (the visible Prev/Next buttons
  // sit outside the form so a tap doesn't accidentally submit).
  assert.match(
    src,
    /formRef\.current\?\.requestSubmit\(\)/,
    "Submit handler must call formRef.current?.requestSubmit() to fire the server action",
  );
});

test("spec 133 — MobileFormRunner serialises array values with the [] suffix", () => {
  const src = read(MOBILE_PATH);
  // Multi-value checkbox groups land as arrays in `values`. The server
  // action in forms/[slug]/page.tsx strips the `[]` suffix on the way in
  // (spec 074), so the mobile renderer must emit it the same way.
  assert.match(
    src,
    /name=\{\s*`\$\{name\}\[\]`\s*\}/,
    "array-valued fields must emit hidden inputs with the [] suffix the server action strips",
  );
});

test("spec 133 — forms/[slug]/page.tsx imports getDeviceType + MobileFormRunner", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
    "page must import getDeviceType from @/lib/device",
  );
  assert.match(
    src,
    /import\s*\{\s*MobileFormRunner\s*\}\s*from\s*"@\/components\/forms\/MobileFormRunner"/,
    "page must import MobileFormRunner from the components alias path",
  );
});

test("spec 133 — forms/[slug]/page.tsx branches the renderer on the device type", () => {
  const src = read(PAGE_PATH);
  // The branch must read the device once and select MobileFormRunner or
  // FormRenderer based on it.
  assert.match(
    src,
    /const device\s*=\s*await getDeviceType\(\)/,
    "page must await getDeviceType() and store the result in a const",
  );
  assert.match(
    src,
    /device\s*===\s*"mobile"/,
    "page must compare device against the 'mobile' literal",
  );
  assert.match(
    src,
    /<MobileFormRunner\b/,
    "page must render <MobileFormRunner /> in the mobile branch",
  );
  // Both renderers must take the same draftKey + action + formId props
  // so a draft saved on one is consumable on the other.
  assert.match(
    src,
    /<FormRenderer\b/,
    "page must still render <FormRenderer /> in the desktop branch",
  );
});

test("spec 133 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [MOBILE_PATH, RENDERER_PATH, PAGE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
