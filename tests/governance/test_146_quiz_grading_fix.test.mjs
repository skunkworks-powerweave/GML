// Governance test for spec 146 — Quiz grading fix (Workflow Run 13
// audit-closure HIGH).
//
// The 7-agent audit logged this finding against the spec 120 / 134
// quiz pipeline:
//
//   Client filters answers to "answered only" before submit. Server
//   grades against all questions in DB. Skipped questions = wrong
//   score.
//
// Spec 146 ships a wire-contract change so the client sends EVERY
// question, with `selectedIndex: null` for any skipped. The server
// tracks an `answeredCount` separately from `correct` and emits it in
// the audit trail. The result page surfaces the answered/correct/
// skipped breakdown and uses the more honest "Skipped" copy.
//
// This test pins:
//   1. All five spec-kit files exist and plan.md follows
//      CREATED / EDITED / MIGRATED.
//   2. QuizRunner.tsx widens `submitAction` to `number | null` and
//      no longer `.filter`s the selection set before submit.
//   3. MobileQuizRunner.tsx does the same.
//   4. submitQuizAttempt accepts the widened type, tracks
//      `answeredCount`, and emits it in the audit metadata.
//   5. The result page renders the `quiz-result-breakdown` testid,
//      treats null as skipped, and uses "Skipped" copy.
//   6. The schema's `quizSubmissions.answers` $type<> allows
//      `number | null`.
//   7. No TODO / FIXME markers in shipped source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const DESKTOP_PATH = "apps/web/src/components/quiz/QuizRunner.tsx";
const MOBILE_PATH = "apps/web/src/components/quiz/MobileQuizRunner.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx";
const RESULT_PATH =
  "apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx";
const SCHEMA_PATH = "packages/db/src/schema/quizzes.ts";
const SPEC_DIR = "specs/146-quiz-grading-fix";

test("spec 146 — all five spec-kit files are present", () => {
  for (const name of [
    "spec.md",
    "plan.md",
    "research.md",
    "quickstart.md",
    "tasks.md",
  ]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the quiz grading fix spec`,
    );
  }
});

test("spec 146 — plan.md follows the CREATED / EDITED / MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /QuizRunner\.tsx/,
    "plan.md must call out the desktop runner edit",
  );
  assert.match(
    src,
    /MobileQuizRunner\.tsx/,
    "plan.md must call out the mobile runner edit",
  );
  assert.match(
    src,
    /submitQuizAttempt/,
    "plan.md must call out the server-action edit",
  );
  assert.match(
    src,
    /quiz-result-breakdown|result.*\[submissionId\]\/page\.tsx|result page/i,
    "plan.md must call out the result-page edit",
  );
});

test("spec 146 — desktop QuizRunner widens submitAction to number | null", () => {
  const src = read(DESKTOP_PATH);
  assert.match(
    src,
    /submitAction:\s*\(\s*slug:\s*string,\s*attemptId:\s*string,\s*answers:\s*Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>,?\s*\)\s*=>\s*Promise<void>/,
    "QuizRunner submitAction must accept `selectedIndex: number | null` per spec 146",
  );
});

test("spec 146 — desktop QuizRunner sends ALL questions on submit (no .filter shrink)", () => {
  const src = read(DESKTOP_PATH);
  // The pre-146 bug pattern: `.filter((qq) => selected[qq.id] !== undefined)`
  // applied to the `questions` array before `.map`. We MUST NOT see this
  // anymore — the whole point of the fix is that every question rides
  // the wire.
  assert.ok(
    !/questions\s*\.filter\(\s*\(qq\)\s*=>\s*selected\[qq\.id\]\s*!==\s*undefined\s*\)/.test(
      src,
    ),
    "QuizRunner must not filter `questions` by `selected[qq.id] !== undefined` before submit (spec 146)",
  );
  // And the positive guarantee: there is a `.map` over the full
  // questions array that emits null when no selection exists.
  assert.match(
    src,
    /questions\.map\(\s*\(qq\)\s*=>\s*\(\s*\{[\s\S]*?questionId:\s*qq\.id[\s\S]*?selectedIndex:[\s\S]*?(null|\?\?)/,
    "QuizRunner must map over the full `questions` array emitting null for skipped entries",
  );
});

test("spec 146 — mobile MobileQuizRunner widens submitAction to number | null", () => {
  const src = read(MOBILE_PATH);
  assert.match(
    src,
    /submitAction:\s*\(\s*slug:\s*string,\s*attemptId:\s*string,\s*answers:\s*Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>,?\s*\)\s*=>\s*Promise<void>/,
    "MobileQuizRunner submitAction must accept `selectedIndex: number | null` per spec 146",
  );
});

test("spec 146 — mobile MobileQuizRunner sends ALL questions on submit (no .filter shrink)", () => {
  const src = read(MOBILE_PATH);
  assert.ok(
    !/questions\s*\.filter\(\s*\(qq\)\s*=>\s*selected\[qq\.id\]\s*!==\s*undefined\s*\)/.test(
      src,
    ),
    "MobileQuizRunner must not filter `questions` by `selected[qq.id] !== undefined` before submit (spec 146)",
  );
  assert.match(
    src,
    /questions\.map\(\s*\(qq\)\s*=>\s*\(\s*\{[\s\S]*?questionId:\s*qq\.id[\s\S]*?selectedIndex:[\s\S]*?(null|\?\?)/,
    "MobileQuizRunner must map over the full `questions` array emitting null for skipped entries",
  );
});

test("spec 146 — submitQuizAttempt accepts widened answers type and tracks answeredCount", () => {
  const src = read(PAGE_PATH);
  // The signature must accept null. (W3-19 put the attempt id the runner was
  // rendered for between slug and answers; the answers shape is unchanged.)
  assert.match(
    src,
    /export\s+async\s+function\s+submitQuizAttempt\(\s*slug:\s*string,[\s\S]*?attemptId:\s*string,\s*answers:\s*Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>/,
    "submitQuizAttempt must accept `selectedIndex: number | null` per spec 146",
  );
  // Server-side: we must guard for null AND undefined when counting.
  assert.match(
    src,
    /picked\s*!==\s*undefined\s*&&\s*picked\s*!==\s*null/,
    "submitQuizAttempt must check both `!== undefined` and `!== null` before counting an answer",
  );
  // answeredCount tracking — proves the skipped/wrong distinction
  // lives in the trail.
  assert.match(
    src,
    /answeredCount/,
    "submitQuizAttempt must track an `answeredCount` separately from `correct`",
  );
  // The percentage rule itself is unchanged: denominator = qs.length.
  assert.match(
    src,
    /correct\s*\/\s*qs\.length/,
    "submitQuizAttempt must still compute percentage against the full DB question count (skipped counts as wrong)",
  );
});

test("spec 146 — quiz.submit audit emits answeredCount in metadata", () => {
  const src = read(PAGE_PATH);
  // Find the recordAudit call and verify answeredCount is in its
  // metadata payload.
  const auditMatch = src.match(
    /recordAudit\(\{[\s\S]*?action:\s*"quiz\.submit"[\s\S]*?metadata:\s*\{([\s\S]*?)\}[\s\S]*?\}\)/,
  );
  assert.ok(
    auditMatch,
    "submitQuizAttempt must call recordAudit({ action: 'quiz.submit', ..., metadata: { ... } })",
  );
  assert.match(
    auditMatch[1],
    /answeredCount/,
    "quiz.submit audit metadata must include `answeredCount` so the trail can distinguish skipped from wrong",
  );
});

test("spec 146 — result page renders the answered/correct/skipped breakdown", () => {
  const src = read(RESULT_PATH);
  // The breakdown element carries a testid so e2e tests can pin it.
  assert.match(
    src,
    /data-testid="quiz-result-breakdown"/,
    "result page must render a `data-testid='quiz-result-breakdown'` element",
  );
  // The breakdown must compute answeredCount + correctCount.
  assert.match(
    src,
    /answeredCount/,
    "result page must compute `answeredCount` for the breakdown",
  );
  assert.match(
    src,
    /correctCount/,
    "result page must compute `correctCount` for the breakdown",
  );
  assert.match(
    src,
    /skippedCount/,
    "result page must compute `skippedCount` for the breakdown",
  );
  // The breakdown must surface the totals visually.
  assert.match(
    src,
    /of\s*\{totalCount\}\s*answered/,
    "result page must render the `X of N answered` copy in the breakdown",
  );
});

test("spec 146 — result page treats null and undefined identically as 'skipped' with honest copy", () => {
  const src = read(RESULT_PATH);
  // The canonical answered predicate.
  assert.match(
    src,
    /picked\s*!==\s*undefined\s*&&\s*picked\s*!==\s*null/,
    "result page must check both `!== undefined` and `!== null` to decide if a question was answered",
  );
  // Copy change — "No answer" out, "Skipped" in.
  assert.ok(
    !/<em>No answer<\/em>/.test(src),
    "result page must NOT use the ambiguous 'No answer' copy (spec 146 replaces it with 'Skipped')",
  );
  assert.match(
    src,
    /<em>Skipped<\/em>/,
    "result page must use the 'Skipped' italic copy for null/undefined picks (spec 146)",
  );
});

test("spec 146 — quizSubmissions.answers $type<> accepts selectedIndex: number | null", () => {
  const src = read(SCHEMA_PATH);
  assert.match(
    src,
    /\$type<Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>>/,
    "quizSubmissions.answers $type<> must allow `selectedIndex: number | null` per spec 146",
  );
});

test("spec 146 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const path of [DESKTOP_PATH, MOBILE_PATH, PAGE_PATH, RESULT_PATH, SCHEMA_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
