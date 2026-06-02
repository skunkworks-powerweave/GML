# Tasks 134 — Mobile quiz runner

## Implementation tasks

1. Read the JSX prototype reference
   `LMS GML Frontend/mobile-runners.jsx::MobQuiz` (lines 369-467).
2. Read the existing desktop runner
   `apps/web/src/components/quiz/QuizRunner.tsx` for the prop shape
   and submit-action contract.
3. Read `apps/web/src/lib/device.ts` for the `getDeviceType()` API.
4. Read
   `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx`
   for the established `device === "mobile"` branching pattern.
5. Read the result page
   `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx`
   to verify it renders fine on mobile already (no variant needed).
6. Create `apps/web/src/components/quiz/MobileQuizRunner.tsx` as a
   `"use client"` component with the same prop surface as
   `QuizRunner` — drop-in replacement for mobile.
7. Wire `useState` + `useTransition` (same pattern as desktop).
8. Render progress dots row with one bar per question, current one
   saffron, answered ink, untouched paper-3.
9. Render full-width question text Crimson Pro 22px.
10. Render four large A/B/C/D option buttons with `min-height: 56`,
    `var(--card-hi)` background, `var(--saffron)` when selected,
    `touchAction: manipulation`.
11. Render sticky bottom action bar with Previous (left) and
    Next/Submit (right) buttons.
12. Apply `env(safe-area-inset-top, 0)` to header padding and
    `env(safe-area-inset-bottom, 0)` to action bar padding.
13. Add `data-testid` hooks for the runner, dots, options, prev/next/
    submit buttons.
14. Edit `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx`:
    - Import `getDeviceType` from `@/lib/device`.
    - Import `MobileQuizRunner` from
      `@/components/quiz/MobileQuizRunner`.
    - `const device = await getDeviceType()` after the data load.
    - Branch on `device === "mobile"` to render
      `<MobileQuizRunner>` instead of `<QuizRunner>`.
    - Pass the same `mappedQuestions` and the same
      `submitQuizAttempt` action to both.

## Spec-kit tasks

1. Write `specs/134-mobile-quiz-runner/spec.md` (the why + what).
2. Write `specs/134-mobile-quiz-runner/plan.md`
   (CREATED / EDITED / MIGRATED contract).
3. Write `specs/134-mobile-quiz-runner/research.md` (JSX source
   walk, device cookie pattern, touch sizing, safe-area, result
   page rationale).
4. Write `specs/134-mobile-quiz-runner/quickstart.md` (dev steps
   to verify in Chrome DevTools device emulation).
5. Write this file (`tasks.md`).

## Test tasks

1. Write `tests/governance/test_134_mobile_quiz_runner.test.mjs`
   with 5+ assertions covering:
   - All five spec-kit files exist under
     `specs/134-mobile-quiz-runner/`.
   - `plan.md` follows the CREATED / EDITED / MIGRATED contract.
   - `MobileQuizRunner.tsx` exists and declares `"use client"`.
   - `MobileQuizRunner` exports a named function with the same prop
     surface as `QuizRunner`.
   - Touch targets ≥ 44 (`min-height: 56` on options,
     `min-height: 48` on action bar).
   - Safe-area inset env() usage on header + action bar.
   - `data-testid` hooks for runner, dots, options, submit.
   - `quizzes/[slug]/page.tsx` imports both runners and branches on
     `device === "mobile"`.
   - No TODO / FIXME markers in shipped source.
2. Run the test, confirm green.
