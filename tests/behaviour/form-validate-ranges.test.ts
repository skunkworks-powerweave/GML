// Scale and number answers are range-checked on the server. EXECUTED -- no
// database needed.
//
// ── F56 ──────────────────────────────────────────────────────────────────────
//
// validate.ts skips option membership for numeric kinds because "the numeric
// block is the real constraint ... it enforces min/max" -- but only the
// school-visit checklist's hygiene rating declares min/max. Every other likert
// and rating field (confidence_*, overall_growth, mentee_progress_rating, ...)
// and every number field (years_teaching, meetings_held, sessions_attended)
// declares none, so the server accepted any finite number: one crafted POST of
// the server action stored confidence_hindi_urdu = 9 on a 1-5 scale and
// years_teaching = -3 in the quarterly reports. The renderers can only produce
// 1..5, so the client and the server disagreed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResponses, type FormField } from "../../apps/web/src/lib/forms/validate.ts";

// Shaped like the seeded fields: no min, no max.
const LIKERT = { name: "confidence_hindi_urdu", kind: "likert", label: "Confidence (Hindi/Urdu)", required: true } as FormField;
const RATING = { name: "mentee_progress_rating", kind: "rating", label: "Mentee progress", required: true } as FormField;
const YEARS = { name: "years_teaching", kind: "number", label: "Years teaching", required: true } as FormField;

const errorsFor = (f: FormField, v: unknown) => validateResponses([f], { [f.name]: v }).map((e) => e.field);

test("a likert answer must be one of its points", () => {
  for (const ok of ["1", "3", "5"]) assert.deepEqual(errorsFor(LIKERT, ok), [], ok);
  for (const bad of ["9", "0", "-1", "6", "2.5"]) assert.deepEqual(errorsFor(LIKERT, bad), [LIKERT.name], bad);
});

test("a likert with its own labels has as many points as labels", () => {
  const three = { ...LIKERT, likertLabels: ["Low", "Mid", "High"] } as unknown as FormField;
  assert.deepEqual(errorsFor(three, "3"), []);
  assert.deepEqual(errorsFor(three, "4"), [LIKERT.name]);
});

test("a rating answer must be a whole star between 1 and starsMax (5 by default)", () => {
  assert.deepEqual(errorsFor(RATING, "5"), []);
  for (const bad of ["6", "0", "4.5"]) assert.deepEqual(errorsFor(RATING, bad), [RATING.name], bad);
  const ten = { ...RATING, starsMax: 10 } as unknown as FormField;
  assert.deepEqual(errorsFor(ten, "10"), []);
});

test("a declared min/max still wins over the implicit scale", () => {
  const hygiene = { name: "classroom_hygiene_rating", kind: "rating", min: 1, max: 3 } as FormField;
  assert.deepEqual(errorsFor(hygiene, "3"), []);
  assert.deepEqual(errorsFor(hygiene, "4"), ["classroom_hygiene_rating"]);
});

test("a number with no declared minimum cannot be negative", () => {
  assert.deepEqual(errorsFor(YEARS, "0"), []);
  assert.deepEqual(errorsFor(YEARS, "12"), []);
  assert.deepEqual(errorsFor(YEARS, "-3"), [YEARS.name]);
  const signed = { ...YEARS, min: -10 } as FormField;
  assert.deepEqual(errorsFor(signed, "-3"), [], "an explicit min is the form's own decision");
});
