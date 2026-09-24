// Server-side form validation, EXECUTED -- no database needed.
//
// The mentee FINAL feedback form could never be submitted. Its required
// `would_recommend` radio is seeded (seed_forms_mentee.ts) with OBJECT options,
//   [{ value: "yes", label: "Yes", hindiLabel: "..." }, { value: "no", ... }]
// and both renderers submit the option's `value` string ("yes"). validate.ts
// built `new Set(field.options)` -- a Set of two object references -- and asked
// it whether it had the string "yes". It never did, so every submission came
// back "is not one of the available choices" and the form bounced forever.
//
// The field below is copied from the seed, not imported: the seed script loads
// dotenv and builds a connection pool at import time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResponses, type FormField } from "../../apps/web/src/lib/forms/validate.ts";

const WOULD_RECOMMEND = {
  name: "would_recommend",
  kind: "radio",
  label: "Would you recommend mentorship to a colleague?",
  required: true,
  options: [
    { value: "yes", label: "Yes", hindiLabel: "हाँ" },
    { value: "no", label: "No", hindiLabel: "नहीं" },
  ],
} as unknown as FormField;

test("a radio with {value,label} options accepts the value the renderer submits", () => {
  assert.deepEqual(validateResponses([WOULD_RECOMMEND], { would_recommend: "yes" }), []);
  assert.deepEqual(validateResponses([WOULD_RECOMMEND], { would_recommend: "no" }), []);
});

test("object options still REJECT a value that is not one of them", () => {
  const errors = validateResponses([WOULD_RECOMMEND], { would_recommend: "maybe" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.field, "would_recommend");
  // And a label is not a value: the renderer submits "yes", never "Yes".
  assert.equal(validateResponses([WOULD_RECOMMEND], { would_recommend: "Yes" }).length, 1);
});

test("plain string options behave exactly as before", () => {
  const f: FormField = { name: "colour", kind: "select", required: true, options: ["red", "blue"] };
  assert.deepEqual(validateResponses([f], { colour: "red" }), []);
  assert.equal(validateResponses([f], { colour: "green" }).length, 1);
});

test("a checkbox with object options accepts several submitted values", () => {
  const f = {
    name: "supports",
    kind: "checkbox",
    options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, "c"],
  } as unknown as FormField;
  assert.deepEqual(validateResponses([f], { supports: ["a", "c"] }), []);
  assert.equal(validateResponses([f], { supports: ["a", "z"] }).length, 1);
});

test("a malformed option in the stored jsonb cannot throw inside the server action", () => {
  const f = {
    name: "odd",
    kind: "radio",
    options: [null, { label: "no value" }, { value: "ok", label: "OK" }],
  } as unknown as FormField;
  assert.doesNotThrow(() => validateResponses([f], { odd: "ok" }));
  assert.deepEqual(validateResponses([f], { odd: "ok" }), []);
  assert.equal(validateResponses([f], { odd: "undefined" }).length, 1, "a missing value must not become the string 'undefined'");
});
