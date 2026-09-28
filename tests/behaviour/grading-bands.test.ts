// Grading maths (apps/web/src/lib/grading/bands.ts): a percentage becomes the
// band it falls in, rounded the way a report card rounds. Every grade in the
// app -- a student's marks, a quiz result, an observation rubric -- comes from
// here, so these rules are the contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bandFor, percentOf, scaleProblems, type Band } from "../../apps/web/src/lib/grading/bands.ts";

const CBSE: Band[] = [
  { label: "A1", minPct: 91, maxPct: 100, isPass: true, sequence: 1 },
  { label: "A2", minPct: 81, maxPct: 90, isPass: true, sequence: 2 },
  { label: "B1", minPct: 71, maxPct: 80, isPass: true, sequence: 3 },
  { label: "B2", minPct: 61, maxPct: 70, isPass: true, sequence: 4 },
  { label: "C1", minPct: 51, maxPct: 60, isPass: true, sequence: 5 },
  { label: "C2", minPct: 41, maxPct: 50, isPass: true, sequence: 6 },
  { label: "D", minPct: 33, maxPct: 40, isPass: true, sequence: 7 },
  { label: "E", minPct: 0, maxPct: 32, isPass: false, sequence: 8 },
];

test("a score becomes a percentage of its maximum", () => {
  assert.equal(percentOf(18, 20), 90);
  assert.equal(percentOf(0, 25), 0);
  assert.equal(percentOf(null, 20), null, "no marks (absent): nothing to grade");
  assert.equal(percentOf(10, 0), null, "no maximum: nothing to grade");
});

test("the percentage rounds to a whole number, then finds its band", () => {
  assert.equal(bandFor(90.5, CBSE)?.label, "A1");
  assert.equal(bandFor(90.4, CBSE)?.label, "A2");
  assert.equal(bandFor(100, CBSE)?.label, "A1");
  assert.equal(bandFor(32.4, CBSE)?.label, "E");
  assert.equal(bandFor(32.5, CBSE)?.label, "D", "32.5 rounds to 33, the pass line");
  assert.equal(bandFor(32.5, CBSE)?.isPass, true);
  assert.equal(bandFor(null, CBSE), null);
  assert.equal(bandFor(110, CBSE)?.label, "A1", "clamped to 100");
});

test("a scale with a gap gives no grade in the gap, and the editor can list gaps and overlaps", () => {
  const gappy: Band[] = [
    { label: "Pass", minPct: 50, maxPct: 100, isPass: true, sequence: 1 },
    { label: "Fail", minPct: 0, maxPct: 40, isPass: false, sequence: 2 },
  ];
  assert.equal(bandFor(45, gappy), null);
  const { gaps, overlaps } = scaleProblems(gappy);
  assert.deepEqual(gaps, [41, 42, 43, 44, 45, 46, 47, 48, 49]);
  assert.deepEqual(overlaps, []);
  assert.deepEqual(scaleProblems(CBSE), { gaps: [], overlaps: [] });
  const overlapping: Band[] = [...gappy, { label: "Near", minPct: 40, maxPct: 55, isPass: false, sequence: 3 }];
  assert.deepEqual(scaleProblems(overlapping).overlaps, [40, 50, 51, 52, 53, 54, 55]);
  assert.equal(bandFor(52, overlapping)?.label, "Pass", "an overlap resolves to the band that starts highest: the better grade");
});
