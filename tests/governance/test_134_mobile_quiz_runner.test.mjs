// Governance test for spec 134 — Mobile quiz runner (Workflow Run 12
// frontend parity, FINAL spec of the run).
//
// Verifies the JSX prototype port at LMS GML Frontend/mobile-runners.jsx
// (lines 369-467, MobQuiz) is wired into a device-aware production
// component with the same grading contract as the desktop QuizRunner
// (spec 120). Specifically asserts:
//
//   1. apps/web/src/components/quiz/MobileQuizRunner.tsx exists, is a
//      "use client" component, exports MobileQuizRunner, and accepts
//      the same prop surface as the desktop QuizRunner (drop-in shape).
//   2. Touch targets meet Apple HIG / Material Design (≥ 44px) — option
//      buttons use min-height: 56 and action bar buttons use min-height: 48.
//   3. Safe-area inset env() is applied to the header (top) and the
//      sticky action bar (bottom).
//   4. Data-testid hooks exist for the runner, the progress dots, each
//      option button, the previous/next/submit buttons, and the error
//      surface — so downstream e2e and visual regression can target them.
//   5. apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx imports
//      both runners, calls getDeviceType(), and branches on the
//      device === "mobile" condition; the same submitQuizAttempt server
//      action is passed to both branches (drop-in grading contract).
//   6. All five spec-kit files exist and plan.md follows the
//      CREATED / EDITED / MIGRATED contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MOBILE_PATH = "apps/web/src/components/quiz/MobileQuizRunner.tsx";
const DESKTOP_PATH = "apps/web/src/components/quiz/QuizRunner.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx";
const SPEC_DIR = "specs/134-mobile-quiz-runner";

test("spec 134 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile quiz runner spec`,
    );
  }
});

test("spec 134 — plan.md follows the CREATED / EDITED / MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileQuizRunner\.tsx/,
    "plan.md must call out the new MobileQuizRunner component in CREATED",
  );
  assert.match(
    src,
    /quizzes\/\[slug\]\/page\.tsx/,
    "plan.md must call out the runner page edit",
  );
  assert.match(
    src,
    /submitQuizAttempt/,
    "plan.md must reference the shared server action so the grading contract is documented",
  );
});

test("spec 134 — MobileQuizRunner.tsx exists and is a client component", () => {
  assert.ok(existsSync(resolve(root, MOBILE_PATH)), `${MOBILE_PATH} must exist`);
  const src = read(MOBILE_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "MobileQuizRunner must declare 'use client' at the top — it owns useState + useTransition",
  );
  assert.match(
    src,
    /export function MobileQuizRunner/,
    "MobileQuizRunner must export a named MobileQuizRunner function so server pages can import it",
  );
});

test("spec 134 — MobileQuizRunner mirrors the desktop QuizRunner prop surface (drop-in shape)", () => {
  const src = read(MOBILE_PATH);
  // Same prop names so the page can swap the component without
  // re-mapping anything.
  assert.match(src, /slug:\s*string/, "MobileQuizRunner must accept slug: string");
  assert.match(src, /title:\s*string/, "MobileQuizRunner must accept title: string");
  assert.match(
    src,
    /questions:\s*MobileQuizRunnerQuestion\[\]/,
    "MobileQuizRunner must accept questions: MobileQuizRunnerQuestion[]",
  );
  // The submit action must take (slug, answers) and return Promise<void> —
  // identical shape to the desktop runner. Post-spec-146 the
  // `selectedIndex` is widened to `number | null` so the server can tell
  // skipped questions apart from answered ones.
  assert.match(
    src,
    /submitAction:\s*\(\s*slug:\s*string,\s*answers:\s*Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>,?\s*\)\s*=>\s*Promise<void>/,
    "MobileQuizRunner submitAction must match the desktop QuizRunner contract exactly (selectedIndex: number | null per spec 146)",
  );
  // Same React state primitives — server-side grading, no client scoring.
  assert.match(
    src,
    /useState/,
    "MobileQuizRunner must use useState for per-question selection state",
  );
  assert.match(
    src,
    /useTransition/,
    "MobileQuizRunner must use useTransition so submit shows a pending state",
  );
});

test("spec 134 — option buttons meet Apple HIG / Material Design touch target sizing (≥ 44)", () => {
  const src = read(MOBILE_PATH);
  // Option buttons render via .map over q.options.
  assert.match(
    src,
    /q\.options\.map/,
    "MobileQuizRunner must map over q.options to render A/B/C/D",
  );
  // Each option must have min-height ≥ 44; we ship 56 so the buttons
  // feel deliberately chunky on 360px viewports.
  assert.match(
    src,
    /minHeight:\s*56/,
    "option buttons must set minHeight: 56 (≥ 44 touch target)",
  );
  // Action bar buttons (Previous / Next / Submit) also need a generous
  // touch target — we ship 48 there.
  assert.match(
    src,
    /minHeight:\s*48/,
    "action bar buttons must set minHeight: 48 (≥ 44 touch target)",
  );
  // touchAction: manipulation suppresses double-tap zoom on rapid
  // A→B re-selections.
  assert.match(
    src,
    /touchAction:\s*"manipulation"/,
    "option buttons must use touchAction: manipulation to suppress double-tap zoom",
  );
});

test("spec 134 — header + action bar respect env(safe-area-inset-*) for notch devices", () => {
  const src = read(MOBILE_PATH);
  // Top of header — iPhone notch / Android punch-hole inset.
  assert.match(
    src,
    /env\(safe-area-inset-top/,
    "header must pad with env(safe-area-inset-top) for notch devices",
  );
  // Bottom of sticky action bar — iPhone home indicator inset.
  assert.match(
    src,
    /env\(safe-area-inset-bottom/,
    "sticky action bar must pad with env(safe-area-inset-bottom) for home indicator",
  );
});

test("spec 134 — selection state uses the saffron tap-fill from the prototype", () => {
  const src = read(MOBILE_PATH);
  // The JSX prototype fills the active option with --saffron (vs the
  // desktop runner which fills with --ink). We honour that.
  assert.match(
    src,
    /var\(--saffron\)/,
    "selected option button must fill with var(--saffron) per the mobile prototype",
  );
  // Un-selected option background is --card-hi per the prototype.
  assert.match(
    src,
    /var\(--card-hi\)/,
    "un-selected option button must use var(--card-hi) background",
  );
});

test("spec 134 — data-testid hooks cover the full interactive surface", () => {
  const src = read(MOBILE_PATH);
  // Runner root.
  assert.match(
    src,
    /data-testid="mobile-quiz-runner"/,
    "runner root must carry data-testid='mobile-quiz-runner'",
  );
  // Progress dots row.
  assert.match(
    src,
    /data-testid="mobile-quiz-dots"/,
    "progress dots row must carry data-testid='mobile-quiz-dots'",
  );
  // Each dot is targetable by index.
  assert.match(
    src,
    /data-testid=\{`mobile-quiz-dot-\$\{i\}`\}/,
    "each progress dot must carry a data-testid='mobile-quiz-dot-<i>'",
  );
  // Each option button.
  assert.match(
    src,
    /data-testid=\{`mobile-quiz-option-\$\{i\}`\}/,
    "each option button must carry a data-testid='mobile-quiz-option-<i>'",
  );
  // Action bar buttons.
  assert.match(
    src,
    /data-testid="mobile-quiz-prev"/,
    "Previous button must carry data-testid='mobile-quiz-prev'",
  );
  assert.match(
    src,
    /data-testid="mobile-quiz-next"/,
    "Next button must carry data-testid='mobile-quiz-next'",
  );
  assert.match(
    src,
    /data-testid="mobile-quiz-submit"/,
    "Submit button must carry data-testid='mobile-quiz-submit'",
  );
});

test("spec 134 — quiz page imports both runners and branches on getDeviceType()", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
    "quizzes/[slug]/page.tsx must import getDeviceType from @/lib/device",
  );
  assert.match(
    src,
    /import\s*\{\s*QuizRunner\s*\}\s*from\s*"@\/components\/quiz\/QuizRunner"/,
    "quizzes/[slug]/page.tsx must still import the desktop QuizRunner",
  );
  assert.match(
    src,
    /import\s*\{\s*MobileQuizRunner\s*\}\s*from\s*"@\/components\/quiz\/MobileQuizRunner"/,
    "quizzes/[slug]/page.tsx must import the new MobileQuizRunner",
  );
  assert.match(
    src,
    /const\s+device\s*=\s*await\s+getDeviceType\(\)/,
    "quizzes/[slug]/page.tsx must call getDeviceType() server-side",
  );
  assert.match(
    src,
    /device\s*===\s*"mobile"/,
    "quizzes/[slug]/page.tsx must branch on device === 'mobile'",
  );
  // The MobileQuizRunner must actually be rendered on the mobile branch.
  assert.match(
    src,
    /<MobileQuizRunner\b/,
    "quizzes/[slug]/page.tsx must render <MobileQuizRunner /> on the mobile branch",
  );
});

test("spec 134 — both runners receive the same submitQuizAttempt action (drop-in grading)", () => {
  const src = read(PAGE_PATH);
  // The mobile branch must pass submitQuizAttempt — same action the
  // desktop branch uses — so grading + audit + redirect are identical.
  // We look for the action being passed to both component invocations.
  const mobileMatch = src.match(
    /<MobileQuizRunner[\s\S]*?submitAction=\{submitQuizAttempt\}[\s\S]*?\/>/,
  );
  assert.ok(
    mobileMatch,
    "MobileQuizRunner must receive submitAction={submitQuizAttempt}",
  );
  const desktopMatch = src.match(
    /<QuizRunner[\s\S]*?submitAction=\{submitQuizAttempt\}[\s\S]*?\/>/,
  );
  assert.ok(
    desktopMatch,
    "desktop QuizRunner must also receive submitAction={submitQuizAttempt} (no fork)",
  );
});

test("spec 134 — desktop QuizRunner is unchanged (sanity — drop-in replacement, no fork)", () => {
  // We don't actually want to assert byte-equality on QuizRunner, but we
  // do want to confirm the existing QuizRunner.tsx still exports the
  // same function — so this test will fail loudly if someone refactors
  // the desktop runner contract by accident.
  const src = read(DESKTOP_PATH);
  assert.match(
    src,
    /export function QuizRunner/,
    "desktop QuizRunner must still export `function QuizRunner` — mobile spec MUST NOT fork the contract",
  );
  assert.match(
    src,
    /submitAction:\s*\(\s*slug:\s*string,\s*answers:\s*Array<\{\s*questionId:\s*string;\s*selectedIndex:\s*number\s*\|\s*null\s*\}>,?\s*\)\s*=>\s*Promise<void>/,
    "desktop QuizRunner submitAction shape must match the mobile contract (selectedIndex: number | null per spec 146)",
  );
});

test("spec 134 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const path of [MOBILE_PATH, PAGE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
