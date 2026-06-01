import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED_PATH = "packages/db/src/scripts/seed_forms_mentee.ts";

test("spec 076: seed_forms_mentee.ts script exists", () => {
  assert.ok(existsSync(resolve(root, SEED_PATH)), `${SEED_PATH} must exist`);
});

test("spec 076: seed script imports dotenv, pg, drizzle, and feedbackForms schema", () => {
  const src = read(SEED_PATH);
  assert.match(src, /import\s*["']dotenv\/config["']/, "must load dotenv/config");
  assert.match(src, /from\s*["']pg["']/, "must import from pg");
  assert.match(src, /from\s*["']drizzle-orm\/node-postgres["']/, "must import drizzle node-postgres adapter");
  assert.match(src, /\bfeedbackForms\b/, "must reference feedbackForms table");
  assert.match(src, /from\s*["']\.\.\/schema\/index\.js["']/, "must import schema from ../schema/index.js (mirrors seed.ts)");
});

test("spec 076: seed script exits 1 if DATABASE_URL is missing", () => {
  const src = read(SEED_PATH);
  assert.match(src, /process\.env\.DATABASE_URL/);
  assert.match(src, /process\.exit\(1\)/);
});

test("spec 076: seed inserts 4 mentee feedback forms (baseline, progress_1, progress_2, final)", () => {
  const src = read(SEED_PATH);
  // All four kinds appear as string literals in the ROWS array.
  assert.match(src, /kind:\s*["']baseline["']/);
  assert.match(src, /kind:\s*["']progress_1["']/);
  assert.match(src, /kind:\s*["']progress_2["']/);
  assert.match(src, /kind:\s*["']final["']/);
  // All four are audience=mentee.
  const menteeMatches = src.match(/audience:\s*["']mentee["']/g) ?? [];
  assert.ok(
    menteeMatches.length >= 4,
    `expected >=4 audience: "mentee" occurrences in ROWS, found ${menteeMatches.length}`,
  );
});

test("spec 076: progress_2 (Q2) is seeded at version '2' per brief", () => {
  const src = read(SEED_PATH);
  // The Q2 row must declare version: "2"
  assert.match(
    src,
    /kind:\s*["']progress_2["'][\s\S]*?version:\s*["']2["']/,
    "progress_2 row must have version: \"2\"",
  );
});

test("spec 076: seed is idempotent — guards via SELECT before insert on (kind,audience,version)", () => {
  const src = read(SEED_PATH);
  // Must perform an existence check using feedbackForms.kind / .audience / .version.
  assert.match(src, /db\s*\n?\s*\.select\(/);
  assert.match(src, /eq\(feedbackForms\.kind/);
  assert.match(src, /eq\(feedbackForms\.audience/);
  assert.match(src, /eq\(feedbackForms\.version/);
  // Must short-circuit on existing rows.
  assert.match(src, /\[skip\]/);
});

test("spec 076: seed supports SEED_DRY_RUN env flag", () => {
  const src = read(SEED_PATH);
  assert.match(src, /SEED_DRY_RUN/);
  assert.match(src, /DRY_RUN/);
});

test("spec 076: forms contain realistic Ladakh teacher questions (English / Hindi-Urdu / Ladakhi)", () => {
  const src = read(SEED_PATH);
  assert.match(src, /English/, "English appears as a question subject");
  assert.match(src, /Urdu/, "Urdu appears in language confidence question");
  assert.match(src, /Ladakhi/, "Ladakhi appears in language confidence question");
  assert.match(src, /years_teaching/, "baseline asks years teaching");
  assert.match(src, /current_grade/, "baseline asks current grade");
  assert.match(src, /biggest_challenge/, "baseline asks biggest classroom challenge");
  assert.match(src, /mentor_expectations/, "baseline asks mentor session expectations");
});

test("spec 076: Likert-5 type used + textarea + radio yes/no on final", () => {
  const src = read(SEED_PATH);
  assert.match(src, /["']likert_5["']/, "likert_5 type literal must appear");
  assert.match(src, /["']textarea["']/, "textarea type literal must appear");
  assert.match(src, /["']radio["']/, "radio type literal must appear");
  // would_recommend on final: yes/no options
  assert.match(src, /would_recommend/);
  assert.match(src, /value:\s*["']yes["']/);
  assert.match(src, /value:\s*["']no["']/);
});

test("spec 076: SM-7 — Hindi labels (hindiLabel) are populated as optional glosses", () => {
  const src = read(SEED_PATH);
  const hindiLabels = src.match(/hindiLabel:/g) ?? [];
  // Spec says ~9+8+9+10 = 36 fields; expect a Hindi gloss on most of them.
  assert.ok(
    hindiLabels.length >= 8,
    `expected many hindiLabel entries (one per field), found ${hindiLabels.length}`,
  );
});

test("spec 076: Q1+Q2 ask about confidence shift, most useful mentor input, still-struggling", () => {
  const src = read(SEED_PATH);
  assert.match(src, /confidence_shift/, "Q1 must ask about confidence shift");
  assert.match(src, /most_useful_input/, "Q1 must ask about most useful mentor input");
  assert.match(src, /still_struggling/, "Q1 must ask about still-struggling-with");
  // Q2 has its own variants
  assert.match(src, /confidence_shift_q2/);
  assert.match(src, /most_useful_input_q2/);
  assert.match(src, /still_struggling_q2/);
});

test("spec 076: final form has overall_growth (Likert) + would_recommend (yes/no) + open_feedback", () => {
  const src = read(SEED_PATH);
  assert.match(src, /overall_growth/);
  assert.match(src, /would_recommend/);
  assert.match(src, /open_feedback_final/);
});

test("spec 076: each form has 8-14 fields (per brief)", () => {
  const src = read(SEED_PATH);
  // Count field entries inside the four FormSchema objects. Each field starts
  // with an `id:` key inside a `fields: [` block.
  const fieldIdMatches = src.match(/\bid:\s*["']/g) ?? [];
  // 9 + 8 + 9 + 10 = 36 fields total expected.
  assert.ok(
    fieldIdMatches.length >= 32 && fieldIdMatches.length <= 56,
    `expected 32-56 field id: literals across 4 forms (9+8+9+10 expected), found ${fieldIdMatches.length}`,
  );
});

test("spec 076: uses pg.Pool + drizzle wrapper and closes the pool", () => {
  const src = read(SEED_PATH);
  assert.match(src, /new Pool\(/);
  assert.match(src, /drizzle\(pool\)/);
  assert.match(src, /pool\.end\(\)/);
});
