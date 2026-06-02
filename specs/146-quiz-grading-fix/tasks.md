# Tasks 146 — Quiz grading fix

## Implementation tasks

1. Read the existing desktop runner
   `apps/web/src/components/quiz/QuizRunner.tsx` to confirm the
   `.filter((qq) => selected[qq.id] !== undefined)` pattern on
   submit.
2. Read the existing mobile runner
   `apps/web/src/components/quiz/MobileQuizRunner.tsx` for the same
   pattern.
3. Read the existing server action
   `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx::submitQuizAttempt`
   to confirm the denominator is `qs.length`.
4. Read the existing result page
   `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx`
   for the "No answer" copy and the answer-map iteration.
5. Read the schema at `packages/db/src/schema/quizzes.ts` to confirm
   `quizSubmissions.answers` is jsonb with
   `$type<Array<{ questionId: string; selectedIndex: number }>>`.
6. Edit `QuizRunner.tsx`:
   - Widen the `submitAction` prop type so `selectedIndex: number | null`.
   - Replace the `.filter` + `.map` chain on submit with a single
     `.map` over the full `questions` array, emitting `null` for any
     skipped entry.
7. Edit `MobileQuizRunner.tsx` with the same two changes — drop-in
   identical contract.
8. Edit `quizzes/[slug]/page.tsx`:
   - Widen `submitQuizAttempt`'s `answers` param type to
     `Array<{ questionId: string; selectedIndex: number | null }>`.
   - Add `answeredCount` to the grading loop, separately from
     `correct`.
   - Add `answeredCount` to the `recordAudit` metadata for the
     `quiz.submit` action.
9. Edit `quizzes/[slug]/result/[submissionId]/page.tsx`:
   - Compute `totalCount`, `answeredCount`, `correctCount`,
     `skippedCount` from the answer map and questions.
   - Render a `data-testid="quiz-result-breakdown"` element below
     the pass/fail banner with the four counts.
   - Treat `picked !== undefined && picked !== null` as the canonical
     "answered" predicate in the per-question card.
   - Replace the "No answer" copy with "Skipped" (italic).
10. Edit `packages/db/src/schema/quizzes.ts`:
    - Widen `quizSubmissions.answers` `$type<>` annotation to
      `Array<{ questionId: string; selectedIndex: number | null }>`.

## Spec-kit tasks

1. Write `specs/146-quiz-grading-fix/spec.md` (why + what we ship).
2. Write `specs/146-quiz-grading-fix/plan.md`
   (CREATED / EDITED / MIGRATED contract).
3. Write `specs/146-quiz-grading-fix/research.md` (the audit
   finding walk, the type-shape decision, the policy choice for
   skipped-counts-as-wrong, the no-migration rationale).
4. Write `specs/146-quiz-grading-fix/quickstart.md` (dev steps to
   reproduce + verify, including the mobile path).
5. Write this file (`tasks.md`).

## Test tasks

1. Update `tests/governance/test_134_mobile_quiz_runner.test.mjs` —
   widen the two `selectedIndex: number` regexes to accept
   `number | null` so spec 134's contract assertions don't fail
   under spec 146.
2. Write `tests/governance/test_146_quiz_grading_fix.test.mjs` with
   at least 7 assertions covering:
   - All five spec-kit files exist under
     `specs/146-quiz-grading-fix/`.
   - `plan.md` follows the CREATED / EDITED / MIGRATED contract.
   - `QuizRunner.tsx` no longer calls `.filter` on its `selected`
     state before submit.
   - `MobileQuizRunner.tsx` no longer calls `.filter` on its
     `selected` state before submit.
   - Both runners' `submitAction` prop type accepts
     `selectedIndex: number | null`.
   - `submitQuizAttempt` accepts the widened type and tracks
     `answeredCount` separately from `correct`.
   - The `quiz.submit` audit metadata includes `answeredCount`.
   - The result page renders the `quiz-result-breakdown` testid.
   - The result page replaces "No answer" with "Skipped".
   - The schema's `quizSubmissions.answers` `$type<>` accepts
     `number | null`.
   - No TODO / FIXME markers leaked into shipped source.
3. Run `pnpm test -- --test-name-pattern="spec 146"` and confirm
   green.
