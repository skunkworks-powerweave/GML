import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED_PATH = "packages/db/src/scripts/seed_forms_misc.ts";
const SPEC_DIR = "specs/078-form-catalog-misc";

test("spec 078: seed_forms_misc.ts exists at packages/db/src/scripts/seed_forms_misc.ts", () => {
  assert.ok(existsSync(resolve(root, SEED_PATH)), `${SEED_PATH} must exist`);
});

test("spec 078: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 078: seed script opens a pg.Pool with DATABASE_URL and uses drizzle", () => {
  const src = read(SEED_PATH);
  assert.match(src, /import\s*\{\s*Pool\s*\}\s*from\s*["']pg["']/);
  assert.match(src, /drizzle\(pool\)/);
  assert.match(src, /process\.env\.DATABASE_URL/);
  // Must also load dotenv for local-dev runs (mirrors seed.ts convention)
  assert.match(src, /import\s+["']dotenv\/config["']/);
});

test("spec 078: seed script imports feedbackForms from the locked schema", () => {
  const src = read(SEED_PATH);
  assert.match(src, /feedbackForms/);
  assert.match(src, /from\s+["']\.\.\/schema\/mentorship\.js["']/);
});

test("spec 078: seed script seeds exactly the two named forms with correct versions", () => {
  const src = read(SEED_PATH);
  // Distinct versions are the idempotency discriminator.
  assert.match(src, /schoolvisit-1/);
  assert.match(src, /endline-1/);
  // The two purposes are embedded in the JSON schema for the renderer.
  assert.match(src, /purpose:\s*["']schoolvisit["']/);
  assert.match(src, /purpose:\s*["']endline["']/);
});

test("spec 078: seed script is idempotent — pre-checks existence by (kind, audience, version)", () => {
  const src = read(SEED_PATH);
  // Existence check uses drizzle's and() + eq() against the natural key triple
  assert.match(src, /import\s*\{[^}]*\band\b[^}]*\beq\b[^}]*\}\s*from\s*["']drizzle-orm["']/);
  assert.match(src, /eq\(feedbackForms\.kind/);
  assert.match(src, /eq\(feedbackForms\.audience/);
  assert.match(src, /eq\(feedbackForms\.version/);
  // And the script branches on the existence-check result (skip vs insert).
  assert.match(src, /existing\.length\s*>\s*0/);
});

test("spec 078: seed script honours SEED_DRY_RUN env flag", () => {
  const src = read(SEED_PATH);
  assert.match(src, /SEED_DRY_RUN/);
  assert.match(src, /DRY_RUN/);
});

test("spec 078: seed script uses ONLY allowed feedbackKindEnum + feedbackAudienceEnum values", () => {
  const src = read(SEED_PATH);
  // kind must be one of: baseline | progress_1 | progress_2 | final
  // For our two rows we use "baseline" (school-visit) and "final" (endline).
  assert.match(src, /kind:\s*["']baseline["']/);
  assert.match(src, /kind:\s*["']final["']/);
  // audience must be one of: mentor | mentee
  assert.match(src, /audience:\s*["']mentor["']/);
  assert.match(src, /audience:\s*["']mentee["']/);
  // And we must NOT have invented unrecognized enum values
  assert.ok(
    !/kind:\s*["']schoolvisit["']/.test(src),
    "must not use kind='schoolvisit' (enum lacks it; route via version instead)",
  );
  assert.ok(
    !/kind:\s*["']endline["']/.test(src),
    "must not use kind='endline' (enum lacks it; route via version instead)",
  );
  assert.ok(
    !/audience:\s*["']teacher["']/.test(src),
    "must not use audience='teacher' (enum lacks it; route via mentor/mentee)",
  );
});

test("spec 078: school-visit form covers the brief's required field ids", () => {
  const src = read(SEED_PATH);
  for (const id of [
    "infra_observations",
    "morning_routine_observed",
    "library_accessible",
    "teacher_attendance_pattern",
    "classroom_hygiene_rating",
  ]) {
    assert.match(src, new RegExp(`id:\\s*["']${id}["']`), `school-visit must include field ${id}`);
  }
});

test("spec 078: endline form covers the brief's required field ids", () => {
  const src = read(SEED_PATH);
  for (const id of [
    "years_in_programme_reflection",
    "top_three_learnings",
    "would_mentor_next_cohort",
    "improvement_suggestions",
  ]) {
    assert.match(src, new RegExp(`id:\\s*["']${id}["']`), `endline must include field ${id}`);
  }
});

test("spec 078: SM-7 — fields support optional Hindi gloss (hindiLabel + var(--deva) renderer key)", () => {
  const src = read(SEED_PATH);
  // hindiLabel must appear on at least one field so the renderer can show
  // a Devanagari secondary line (rendered with font-family: var(--deva)).
  assert.match(src, /hindiLabel/);
  // And the typing must mark it optional (`hindiLabel\?:`).
  assert.match(src, /hindiLabel\?:/);
});

test("spec 078: school-visit infrastructure observations is a boolean-group with the five expected options", () => {
  const src = read(SEED_PATH);
  for (const opt of [
    "Toilets functional",
    "Drinking water available",
    "Furniture intact",
    "Blackboard usable",
    "Library room exists",
  ]) {
    assert.match(src, new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(src, /kind:\s*["']boolean-group["']/);
});

test("spec 078: endline 'would mentor next cohort' is single-choice yes/no", () => {
  const src = read(SEED_PATH);
  // The yes/no choice list must appear inside an options array on that field.
  const block = src.match(/would_mentor_next_cohort[\s\S]{0,400}/);
  assert.ok(block, "would_mentor_next_cohort block must be present");
  assert.match(block[0], /kind:\s*["']single-choice["']/);
  assert.match(block[0], /["']Yes["']/);
  assert.match(block[0], /["']No["']/);
});

test("spec 078: classroom hygiene is rating 1-5", () => {
  const src = read(SEED_PATH);
  const block = src.match(/classroom_hygiene_rating[\s\S]{0,300}/);
  assert.ok(block, "classroom_hygiene_rating block must be present");
  assert.match(block[0], /kind:\s*["']rating["']/);
  assert.match(block[0], /min:\s*1/);
  assert.match(block[0], /max:\s*5/);
});

test("spec 078: pool is closed on both happy and error paths (no leaks)", () => {
  const src = read(SEED_PATH);
  // pool.end() must appear at least twice (happy path + error path).
  const ends = src.match(/pool\.end\(\)/g) ?? [];
  assert.ok(ends.length >= 2, `expected at least 2 pool.end() calls (happy + error), found ${ends.length}`);
});

test("spec 078: forms are marked active:true so the renderer surfaces them by default", () => {
  const src = read(SEED_PATH);
  assert.match(src, /active:\s*true/);
});

test("spec 078: spec.md documents the schema deviation around the locked enum", () => {
  const src = read(`${SPEC_DIR}/spec.md`);
  assert.match(src, /feedbackKindEnum/);
  assert.match(src, /version/);
  assert.match(src, /schoolvisit/);
  assert.match(src, /endline/);
});

test("spec 078: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 078: no stub / TODO / placeholder markers in the seed script", () => {
  const src = read(SEED_PATH);
  assert.ok(!/\bTODO\b/i.test(src), "seed script must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "seed script must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "seed script must not contain 'placeholder' literals");
});
