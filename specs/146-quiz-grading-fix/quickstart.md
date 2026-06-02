# Quickstart 146 — verify the quiz grading fix

## Run the governance test

```bash
cd C:/Users/himan/OneDrive/Desktop/GML/lms-app
pnpm test --filter=tests -- --test-name-pattern="spec 146"
```

Expected: all assertions pass (7+).

## Smoke-test in dev

1. `pnpm dev` from the repo root.
2. Log in as a trainee.
3. Pick a 10-question quiz from `/quizzes` (the seed includes one
   via spec 086).
4. Answer questions 1, 2, 3 — picking the correct option for each.
5. Tap Next through to question 4.
6. Tap Previous twice — back to question 2.
7. Tap Next four times — landing on question 6 without having picked
   anything for 4 or 5. (Note: you'll see the Next button enable
   only when the CURRENT question is selected; for a true skip test
   navigate by tapping Previous back from a later question that you
   answered.)
8. Continue and Submit on the last answered question.
9. On the result page verify:
   - The percentage is `correct / total * 100`, with skipped counting
     against the denominator. (E.g. 3 correct of 10 total = 30%, even
     if you only answered 5.)
   - The breakdown line reads
     `X of N answered · Y correct of N · Z skipped`.
   - The per-question card for each skipped question shows the
     italic copy "Skipped" instead of "No answer".
   - The per-question card for skipped questions still shows the red
     × icon — because skipped is graded as wrong against the
     percentage, the icon is honest.
10. Open the audit log (admin view) and verify the `quiz.submit` row
    has both `score` AND `answeredCount` in its `metadata` blob.

## Mobile smoke test

1. Toggle Chrome DevTools device emulation to `iPhone 14 Pro`.
2. Repeat steps 3-10 above.
3. Verify the mobile runner sends the same wire shape (DevTools
   Network tab → fetch payload should include every question ID,
   with `selectedIndex: null` for the unanswered ones).

## Roll back

To roll spec 146 back without losing prior submissions:

1. Revert the four `.tsx` files to their pre-146 state.
2. Revert the `$type<>` widening in `packages/db/src/schema/quizzes.ts`.
3. Revert the regex widening in
   `tests/governance/test_134_mobile_quiz_runner.test.mjs`.
4. Delete `tests/governance/test_146_quiz_grading_fix.test.mjs`.
5. Delete `specs/146-quiz-grading-fix/`.

Pre-146 submissions remain intact. Post-146 submissions also remain
intact — the rolled-back result page treats any null selectedIndex
the same way it treats a missing entry (both = "No answer").
