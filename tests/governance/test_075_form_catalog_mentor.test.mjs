import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCRIPT = "packages/db/src/scripts/seed_forms_mentor.ts";
const SPEC = "specs/075-form-catalog-mentor/spec.md";

test("spec 075: seed script + spec files exist", () => {
  assert.ok(existsSync(resolve(root, SCRIPT)), `${SCRIPT} must exist`);
  assert.ok(existsSync(resolve(root, SPEC)), `${SPEC} must exist`);
  for (const f of ["plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, `specs/075-form-catalog-mentor/${f}`)),
      `specs/075-form-catalog-mentor/${f} must exist`,
    );
  }
});

test("spec 075: script imports drizzle + feedbackForms and uses (kind, audience, version) idempotency", () => {
  const src = read(SCRIPT);
  assert.match(src, /from\s+"drizzle-orm\/node-postgres"/, "uses drizzle node-postgres driver");
  assert.match(src, /import\s*\{\s*Pool\s*\}\s*from\s+"pg"/, "imports pg Pool");
  assert.match(src, /feedbackForms/, "references feedbackForms table");
  assert.match(src, /from\s+"\.\.\/schema\/mentorship\.js"/, "imports from local mentorship schema");
  // Idempotency: SELECT-before-INSERT with eq() on all three uniqueness keys.
  assert.match(src, /eq\(feedbackForms\.kind/, "filters by kind");
  assert.match(src, /eq\(feedbackForms\.audience/, "filters by audience");
  assert.match(src, /eq\(feedbackForms\.version/, "filters by version");
  assert.match(src, /\bskipped\b/, "tracks skipped count");
});

test("spec 075: script seeds all four feedbackKindEnum values for the mentor audience", () => {
  const src = read(SCRIPT);
  for (const kind of ["baseline", "progress_1", "progress_2", "final"]) {
    assert.match(src, new RegExp(`kind:\\s*"${kind}"`), `seed must include kind=${kind}`);
  }
  // Every form is audience=mentor — there must be four occurrences.
  const matches = src.match(/audience:\s*"mentor"/g) ?? [];
  assert.equal(matches.length, 4, "exactly four mentor-audience forms");
  // progress_2 carries version "2" per spec brief.
  assert.match(src, /kind:\s*"progress_2"[\s\S]{0,200}version:\s*"2"/, "progress_2 has version \"2\"");
});

test("spec 075: each form schema uses the locked {fields:[{name,label,kind,required,...}]} shape", () => {
  const src = read(SCRIPT);
  // Mandatory field keys appear in the FormField interface declaration.
  assert.match(src, /interface\s+FormField\s*\{[\s\S]*?name:\s*string[\s\S]*?label:\s*string[\s\S]*?kind:\s*FieldKind[\s\S]*?required:\s*boolean/);
  // Each of the four canonical forms is declared as a SeedForm constant.
  for (const c of ["MENTOR_BASELINE", "MENTOR_PROGRESS_Q1", "MENTOR_PROGRESS_Q2", "MENTOR_FINAL"]) {
    assert.match(src, new RegExp(`const\\s+${c}:\\s*SeedForm`), `${c} declared as SeedForm`);
  }
  // FORMS array gathers exactly those four.
  assert.match(src, /const\s+FORMS:\s*SeedForm\[\]\s*=\s*\[\s*MENTOR_BASELINE,\s*MENTOR_PROGRESS_Q1,\s*MENTOR_PROGRESS_Q2,\s*MENTOR_FINAL\s*\]/);
});

test("spec 075: mentor baseline covers bio + expertise + goals + meeting style fields", () => {
  const src = read(SCRIPT);
  // The brief explicitly requires these four mentor-baseline questions.
  assert.match(src, /name:\s*"bio"/, "baseline includes bio field");
  assert.match(src, /name:\s*"expertise_areas"[\s\S]*?kind:\s*"checkboxes"/, "expertise_areas is a checkboxes multi-select");
  assert.match(src, /name:\s*"expected_goals"[\s\S]*?kind:\s*"textarea"/, "expected_goals is a textarea");
  assert.match(src, /name:\s*"preferred_meeting_style"[\s\S]*?kind:\s*"radio"/, "preferred_meeting_style is a radio");
});

test("spec 075: progress forms include rating + narrative + concerns; final has holistic + recommendation + achievements", () => {
  const src = read(SCRIPT);
  // Progress quarter forms have the three brief-mandated shapes.
  assert.match(src, /name:\s*"mentee_progress_rating"[\s\S]*?kind:\s*"rating"/, "progress forms include rating");
  assert.match(src, /name:\s*"narrative_reflection"[\s\S]*?kind:\s*"textarea"/, "progress forms include narrative");
  assert.match(src, /name:\s*"concerns"[\s\S]*?kind:\s*"textarea"/, "progress forms include concerns");
  // Final form keys.
  assert.match(src, /name:\s*"holistic_rating"[\s\S]*?kind:\s*"rating"/, "final form has holistic_rating");
  assert.match(src, /name:\s*"recommendation"[\s\S]*?kind:\s*"radio"/, "final form has recommendation radio");
  assert.match(src, /name:\s*"achievements"[\s\S]*?kind:\s*"textarea"/, "final form has achievements textarea");
});

test("spec 075: script supports DRY_RUN, requires DATABASE_URL, and is runnable via main()", () => {
  const src = read(SCRIPT);
  assert.match(src, /SEED_DRY_RUN|DRY_RUN/, "honours DRY_RUN env flag");
  assert.match(src, /DATABASE_URL/, "checks for DATABASE_URL");
  assert.match(src, /process\.exit\(1\)/, "exits non-zero on failure");
  assert.match(src, /async\s+function\s+main\s*\(/, "declares main()");
  assert.match(src, /main\(\)\.catch/, "wires main() error handler");
  // Must close the pool on the happy path.
  assert.match(src, /pool\.end\(\)/, "closes the pg pool");
});

test("spec 075: each form has between 6 and 12 fields per FR-003 (sanity-check by counting field blocks)", () => {
  const src = read(SCRIPT);
  // Each form constant is followed by a `fields:` array. Approximate the count
  // by parsing on the `name:` keys within each named const block.
  const blocks = ["MENTOR_BASELINE", "MENTOR_PROGRESS_Q1", "MENTOR_PROGRESS_Q2", "MENTOR_FINAL"];
  for (const blockName of blocks) {
    const start = src.indexOf(`const ${blockName}: SeedForm`);
    assert.ok(start >= 0, `${blockName} must be declared`);
    // Slice the block until the next top-level const declaration or end of file.
    const remainder = src.slice(start);
    const nextStart = remainder.slice(20).search(/\nconst\s+\w+:\s*SeedForm|\nconst\s+FORMS:/);
    const block = nextStart > 0 ? remainder.slice(0, 20 + nextStart) : remainder;
    const nameCount = (block.match(/\bname:\s*"/g) ?? []).length;
    assert.ok(
      nameCount >= 6 && nameCount <= 12,
      `${blockName} must have 6–12 fields, found ${nameCount}`,
    );
  }
});
