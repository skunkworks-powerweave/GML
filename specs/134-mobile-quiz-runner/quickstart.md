# Quickstart 134 — verify the mobile quiz runner

## Run the governance test

```bash
cd C:/Users/himan/OneDrive/Desktop/GML/lms-app
pnpm test --filter=tests -- --test-name-pattern="spec 134"
```

Expected: all assertions pass.

## Smoke-test in dev

1. `pnpm dev` from the repo root.
2. Log in as a trainee.
3. Pick a quiz from `/quizzes` (any slug — the seed inserts a few
   sample quizzes via spec 086).
4. Open Chrome DevTools → Toggle device toolbar → pick `iPhone 14 Pro`.
5. Refresh the quiz page.
6. Verify:
   - The runner takes the full viewport (no centered card).
   - Progress dots are at the top, one per question.
   - Question text uses Crimson Pro 22px.
   - Four option buttons are full-width and ≥ 56px tall.
   - Tapping an option fills it with `--saffron` background.
   - Bottom action bar is sticky with Previous (disabled on Q1) and
     Next (or Submit on the last question).
   - Bottom action bar respects the iPhone home-indicator inset
     (visible gap below the buttons).
7. Tap through all questions answering each.
8. On the last question, tap **Submit**.
9. Verify the redirect lands on
   `/quizzes/<slug>/result/<submissionId>`.
10. Verify the score % and per-question breakdown show on the result
    page (this is the existing desktop layout, intentionally — no
    mobile result variant in this spec).

## Toggle back to desktop

1. In DevTools, exit device emulation.
2. Refresh.
3. Verify the desktop QuizRunner card layout is restored (centered
   single card with the single progress bar).

The branching happens server-side via the `gml-device` cookie set by
`useDeviceType()`, so the first load after the toggle uses the new
layout. The client-side effect keeps the cookie in sync on
subsequent navigations.

## Roll back

To roll spec 134 back without touching the desktop runner:

1. Remove the import of `MobileQuizRunner` from
   `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx`.
2. Remove the import of `getDeviceType` from the same file.
3. Drop the `device === "mobile"` branch.
4. Delete `apps/web/src/components/quiz/MobileQuizRunner.tsx`.
5. Delete `tests/governance/test_134_mobile_quiz_runner.test.mjs`.

The grading contract, the desktop runner, the result page, and the
seed are all untouched — they continue to work as before.
