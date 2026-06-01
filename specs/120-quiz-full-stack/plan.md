# Plan 120

CREATED:
- `packages/db/src/schema/quizzes.ts` (3 tables: quizzes, quiz_questions, quiz_submissions)
- `packages/db/src/migrations/0014_quizzes_schema.sql` (CREATE TABLEs + FKs + indexes + CHECKs)
- `packages/db/src/migrations/meta/0014_snapshot.json` (full schema snapshot mirroring 0013 + new tables)
- `apps/web/src/components/quiz/QuizRunner.tsx` ('use client' multiple-choice runner)
- `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx` (server component + submitQuizAttempt action)
- `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx` (result + per-question breakdown)
- `apps/web/src/app/(authenticated)/admin/quizzes/page.tsx` (registry index, role-gated)
- `apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx` (server + 'use client' editor)
- `apps/web/src/app/(authenticated)/admin/quizzes/[id]/parts.tsx` ('use client' QuizSchemaEditor)
- `apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts` ('use server' saveQuizSchema + validation)
- `tests/governance/test_120_quiz_full_stack.test.mjs` (10+ assertions)
- `specs/120-quiz-full-stack/{spec,plan,research,quickstart,tasks}.md`

EDITED:
- `packages/db/src/schema/index.ts` (added `export * from "./quizzes"`)
- `packages/db/src/migrations/meta/_journal.json` (idx 14 → tag 0014_quizzes_schema)

MIGRATED: 0014_quizzes_schema (3 new tables — first migration in Run 10's frontend-parity sweep).
