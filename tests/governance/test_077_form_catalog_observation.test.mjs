import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED_PATH = "packages/db/src/scripts/seed_forms_observation.ts";

test("spec 077: seed script exists at packages/db/src/scripts/seed_forms_observation.ts", () => {
  assert.ok(
    existsSync(resolve(root, SEED_PATH)),
    `${SEED_PATH} must exist`,
  );
});

test("spec 077: seed script loads dotenv, opens a pg Pool, and uses drizzle node-postgres", () => {
  const src = read(SEED_PATH);
  assert.match(src, /import\s+"dotenv\/config"/, "must load dotenv");
  assert.match(
    src,
    /from\s+"drizzle-orm\/node-postgres"/,
    "must use drizzle node-postgres adapter",
  );
  assert.match(src, /from\s+"pg"/, "must import pg for Pool");
  assert.match(src, /new Pool\(\s*\{\s*connectionString:/);
});

test("spec 077: seed script checks DATABASE_URL and exits with helpful message if missing", () => {
  const src = read(SEED_PATH);
  assert.match(src, /process\.env\.DATABASE_URL/);
  assert.match(src, /DATABASE_URL not set/);
  assert.match(src, /process\.exit\(1\)/);
});

test("spec 077: seed script supports SEED_DRY_RUN=true short-circuit", () => {
  const src = read(SEED_PATH);
  assert.match(src, /SEED_DRY_RUN/);
  assert.match(src, /DRY_RUN/);
});

test("spec 077: seed script targets observation_forms (NOT feedback_forms) via canonical cycle OBS-2026-001", () => {
  const src = read(SEED_PATH);
  assert.match(
    src,
    /observationForms/,
    "must reference observationForms table",
  );
  assert.match(
    src,
    /observationCycles/,
    "must reference observationCycles table",
  );
  assert.ok(
    !/\bfeedbackForms\b/.test(src),
    "must NOT use feedbackForms — brief explicitly says observation_forms",
  );
  assert.match(src, /OBS-2026-001/, "must look up canonical seed cycle");
});

test("spec 077: seed script inserts three kinds — pre, post, observer", () => {
  const src = read(SEED_PATH);
  assert.match(src, /kind:\s*"pre"/);
  assert.match(src, /kind:\s*"post"/);
  assert.match(src, /kind:\s*"observer"/);
});

test("spec 077: pre template includes lessonPlanSummary, learningOutcomes, anticipatedDifficulties", () => {
  const src = read(SEED_PATH);
  assert.match(src, /lessonPlanSummary/);
  assert.match(src, /learningOutcomes/);
  assert.match(src, /anticipatedDifficulties/);
});

test("spec 077: post template includes whatWorked, whatDidNot, surpriseMoments, nextTime", () => {
  const src = read(SEED_PATH);
  assert.match(src, /whatWorked/);
  assert.match(src, /whatDidNot/);
  assert.match(src, /surpriseMoments/);
  assert.match(src, /nextTime/);
});

test("spec 077: observer template includes 5 rubric scales + narrativeComments", () => {
  const src = read(SEED_PATH);
  for (const key of [
    "lessonStructure",
    "studentEngagement",
    "teacherQuestioning",
    "classroomManagement",
    "languageUse",
    "narrativeComments",
  ]) {
    assert.match(src, new RegExp(`\\b${key}\\b`), `must include ${key} field`);
  }
});

test("spec 077: observer rubric scale fields declare min:1, max:5, anchors array", () => {
  const src = read(SEED_PATH);
  assert.match(src, /type:\s*"scale"/);
  assert.match(src, /min:\s*1/);
  assert.match(src, /max:\s*5/);
  assert.match(src, /anchors:\s*\[/);
});

test("spec 077: seed script uses onConflictDoNothing for idempotence (cycleId, kind)", () => {
  const src = read(SEED_PATH);
  assert.match(src, /onConflictDoNothing/);
  assert.match(src, /observationForms\.cycleId/);
  assert.match(src, /observationForms\.kind/);
});

test("spec 077: seed script writes schemaVersion '1' and leaves submittedByUserId null", () => {
  const src = read(SEED_PATH);
  assert.match(src, /schemaVersion:\s*"1"/);
  assert.match(src, /submittedByUserId:\s*null/);
});

test("spec 077: seed script prints inserted/skipped/total summary and has top-level catch", () => {
  const src = read(SEED_PATH);
  assert.match(src, /inserted/);
  assert.match(src, /skipped/);
  assert.match(src, /main\(\)\.catch\(/);
  assert.match(src, /pool\.end\(\)/);
});

test("spec 077: seed script directs operator to run seed.ts first if canonical cycle missing", () => {
  const src = read(SEED_PATH);
  assert.match(src, /run\s+seed/);
});

test("spec 077: spec.md, plan.md, research.md, quickstart.md, tasks.md all exist", () => {
  for (const f of [
    "specs/077-form-catalog-observation/spec.md",
    "specs/077-form-catalog-observation/plan.md",
    "specs/077-form-catalog-observation/research.md",
    "specs/077-form-catalog-observation/quickstart.md",
    "specs/077-form-catalog-observation/tasks.md",
  ]) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});
