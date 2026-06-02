# Plan 134

CREATED: `specs/134-mobile-quiz-runner/{spec,plan,research,quickstart,tasks}.md`, `apps/web/src/components/quiz/MobileQuizRunner.tsx` (full-screen one-question-per-screen client component, same prop surface as QuizRunner — slug / title / questions / submitAction — so the page treats it as a drop-in mobile replacement), `tests/governance/test_134_mobile_quiz_runner.test.mjs`

EDITED: `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx` (import `getDeviceType` from `@/lib/device`, import `MobileQuizRunner`, await the device cookie, branch on `device === "mobile"` to render `<MobileQuizRunner>` vs `<QuizRunner>`; both share the same `mappedQuestions` mapping and the same `submitQuizAttempt` server action declared at the top of the file)

MIGRATED: none — the mobile runner is pure UI atop the existing spec 120 quiz pipeline (`quizzes`, `quizQuestions`, `quizSubmissions` tables, `submitQuizAttempt` server action, `quiz.submit` audit). No new env vars, no new schema, no new dependencies. The result page (`/quizzes/[slug]/result/[submissionId]`) does NOT need a mobile variant; verified — the existing card has `maxWidth: 640` and a vertical question stack that already shrinks to small viewports correctly.
