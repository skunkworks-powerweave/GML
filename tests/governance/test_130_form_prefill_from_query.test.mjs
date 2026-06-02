// Governance test for spec 130 — form prefill + context threading from query string.
//
// Closes the Workflow Run 11 frontend-parity gap on /forms/[slug]: the
// catalogue pages link in with rich context (cycleId / quarter / observerId /
// kind) and the runner used to drop everything except pairingId. Two files are
// under audit:
//
//   1. apps/web/src/app/(authenticated)/forms/[slug]/page.tsx
//      — server component, parses the closed CONTEXT_KEYS set out of the
//        searchParams, sanitizes per-key (quarter ∈ [1,4], IDs match a safe
//        char class), passes a `context` prop to FormRenderer, layers
//        `?prefill_<fieldName>=value` under any draft / prior submission,
//        and re-reads `__ctx_<key>` on submit to fold into responses jsonb +
//        audit metadata.
//   2. apps/web/src/components/forms/FormRenderer.tsx
//      — accepts an optional `context?: Record<string, string>` prop and
//        plants hidden `__ctx_<key>` inputs alongside the existing __formId /
//        __slug / __pairingId hidden inputs.
//
// Plus the five spec-kit files under specs/130-form-prefill-from-query/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const RENDERER_PATH = "apps/web/src/components/forms/FormRenderer.tsx";
const SPEC_DIR = "specs/130-form-prefill-from-query";

test("spec 130 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the form-prefill spec`,
    );
  }
});

test("spec 130 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
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
    "plan.md must call out the renderer in EDITED",
  );
});

test("spec 130 — page declares a closed CONTEXT_KEYS allow-list with the four expected keys", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /CONTEXT_KEYS\s*=\s*\[[^\]]*\]\s*as\s*const/,
    "page must declare CONTEXT_KEYS as a closed `as const` tuple",
  );
  // The closed allow-list is the security boundary — every key must be present
  // by exact name.
  const m = src.match(/CONTEXT_KEYS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, "page must declare CONTEXT_KEYS with literal string entries");
  const body = m[1];
  for (const key of ["cycleId", "quarter", "observerId", "kind"]) {
    assert.match(
      body,
      new RegExp(`"${key}"`),
      `CONTEXT_KEYS must include "${key}" so the catalogue link can thread it through`,
    );
  }
});

test("spec 130 — sanitizeContextValue enforces quarter ∈ [1,4] and a safe ID char class", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /function\s+sanitizeContextValue/,
    "page must declare a sanitizeContextValue helper used on both ingress and egress",
  );
  // Quarter must clamp to 1..4 — anything outside is dropped.
  assert.match(
    src,
    /n\s*<\s*1\s*\|\|\s*n\s*>\s*4/,
    "sanitizeContextValue must reject quarter outside [1,4]",
  );
  // IDs must match a conservative character class to prevent HTML/audit-log
  // poisoning via tampered URLs.
  assert.match(
    src,
    /\[a-zA-Z0-9_-\]\+/,
    "sanitizeContextValue must gate IDs on a safe [a-zA-Z0-9_-]+ character class",
  );
});

test("spec 130 — page reads the four context keys out of searchParams and passes them to FormRenderer", () => {
  const src = read(PAGE_PATH);
  // The page must iterate CONTEXT_KEYS (not hard-code each get) so adding a new
  // key is a single-line edit.
  assert.match(
    src,
    /for\s*\(\s*const\s+key\s+of\s+CONTEXT_KEYS\s*\)/,
    "page must iterate CONTEXT_KEYS when extracting context from searchParams",
  );
  // The renderer call must carry the new context prop.
  assert.match(
    src,
    /<FormRenderer[\s\S]*?context=\{context\}/,
    "page must pass a context prop to FormRenderer with the extracted context dict",
  );
});

test("spec 130 — page prefill is gated on the active form's field-name set", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /fieldNames\s*=\s*new\s+Set/,
    "page must build a Set of active field names for the prefill gate",
  );
  // The crucial branch — drop prefill keys that don't match a known field.
  assert.match(
    src,
    /prefill_/,
    "page must consume the prefill_<fieldName> query convention",
  );
  assert.match(
    src,
    /if\s*\(!fieldNames\.has\(fieldName\)\)\s*continue;/,
    "page must drop prefill_<unknown> keys on the floor (prevents HTML injection)",
  );
});

test("spec 130 — prefill is layered under drafts and prior submissions, not over them", () => {
  const src = read(PAGE_PATH);
  // The initialResponses computation must spread baseResponses (draft || prior)
  // first and only merge prefill into empty slots — never overwriting work.
  assert.match(
    src,
    /baseResponses/,
    "page must compose a baseResponses (draft || prior) before applying prefill",
  );
  assert.match(
    src,
    /initialResponses\[name\]\s*===\s*undefined\s*\|\|\s*initialResponses\[name\]\s*===\s*""/,
    "page must only fill prefill values into empty slots (drafts always win)",
  );
});

test("spec 130 — submitFormAction re-reads __ctx_<key> from FormData and re-sanitizes", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /formData\.get\(\s*`__ctx_\$\{key\}`\s*\)/,
    "action must read __ctx_<key> from FormData (matches the renderer hidden inputs)",
  );
  // Defence in depth — the action must call sanitizeContextValue again, not
  // trust the renderer alone.
  assert.match(
    src,
    /sanitizeContextValue\(\s*key\s*,/,
    "action must re-sanitize context values on the way in (defence in depth)",
  );
});

test("spec 130 — submitFormAction persists context into responses.__context and audit metadata", () => {
  const src = read(PAGE_PATH);
  // The persisted block lives under a reserved __context key (double-underscore
  // is already excluded from the responses field loop).
  assert.match(
    src,
    /responses\.__context\s*=\s*context/,
    "action must persist the context dict under responses.__context",
  );
  // The audit row must spread context so reviewers can filter by cycle / quarter.
  assert.match(
    src,
    /\.\.\.context/,
    "action must spread context into recordAudit metadata so the audit log is filterable",
  );
});

test("spec 130 — FormRenderer extends its prop type with optional context (back-compat)", () => {
  const src = read(RENDERER_PATH);
  // The new prop is optional and a flat string->string map — keeps the public
  // API stable for every other call site.
  assert.match(
    src,
    /context\?:\s*Record<string,\s*string>/,
    "FormRenderer must declare context as optional Record<string, string>",
  );
});

test("spec 130 — FormRenderer plants hidden __ctx_<key> inputs for each context entry", () => {
  const src = read(RENDERER_PATH);
  // The renderer must iterate context entries and emit hidden inputs.
  assert.match(
    src,
    /Object\.entries\(context\)/,
    "FormRenderer must iterate context entries when rendering hidden inputs",
  );
  assert.match(
    src,
    /name=\{\s*`__ctx_\$\{k\}`\s*\}/,
    "FormRenderer must name each hidden input __ctx_<key> so the server action can read it",
  );
  assert.match(
    src,
    /type="hidden"/,
    "context inputs must be type=hidden so they post but never render visually",
  );
});

test("spec 130 — FormRenderer still plants the spec-074 __formId / __slug / __pairingId hidden inputs", () => {
  const src = read(RENDERER_PATH);
  // Back-compat — the spec-074 server action depends on these three hidden
  // inputs. The pairingId pattern was the brief's reference point.
  assert.match(
    src,
    /name="__formId"/,
    "FormRenderer must keep planting the __formId hidden input (spec 074 contract)",
  );
  assert.match(
    src,
    /name="__slug"/,
    "FormRenderer must keep planting the __slug hidden input (spec 074 contract)",
  );
  assert.match(
    src,
    /name="__pairingId"/,
    "FormRenderer must keep planting the __pairingId hidden input (spec 074 contract)",
  );
});

test("spec 130 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [PAGE_PATH, RENDERER_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
