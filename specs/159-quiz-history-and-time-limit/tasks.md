# Tasks 159

- [x] T1 → write the governance test (red) covering:
  - all five spec-kit files exist at `specs/159-quiz-history-and-time-limit/`;
  - `packages/db/src/schema/quizzes.ts` declares
    `timeLimitSeconds: integer("time_limit_seconds")` and the
    `quizzes_time_limit_range` CHECK;
  - `0019_quiz_time_limit.sql` contains both `ALTER TABLE ... ADD COLUMN`
    and `ADD CONSTRAINT ... CHECK (...)` statements;
  - `0019_snapshot.json` chains its `prevId` off 0018's `id`, declares
    the new column, and declares the new check constraint;
  - `_journal.json` carries an entry with `idx: 19, tag:
    "0019_quiz_time_limit"` between idx 18 and idx 20;
  - `QuizRunner.tsx` accepts `timeLimitSeconds?: number | null` and
    renders a `data-testid="quiz-countdown"` element;
  - `MobileQuizRunner.tsx` accepts the same prop and renders a
    `data-testid="mobile-quiz-countdown"` element;
  - `/quizzes/[slug]/page.tsx` forwards `quiz.timeLimitSeconds` to
    both runners;
  - the admin editor (`/admin/quizzes/[id]/actions.ts`) validates
    the field and rejects out-of-range values with
    `invalid_time_limit`;
  - the history page exists at
    `/quizzes/[slug]/history/page.tsx` and renders
    `data-testid="quiz-history-table"` or
    `data-testid="quiz-history-empty"`;
  - the result page links to `/quizzes/[slug]/history` via
    `data-testid="quiz-result-history-link"`.
  Run suite → red.
- [x] T2 → edit `packages/db/src/schema/quizzes.ts`: add the
  `timeLimitSeconds` column + `quizzes_time_limit_range` CHECK
  constraint with the inline Spec 159 rationale block. Run scoped
  governance test → schema-shape assertion green.
- [x] T3 → create `packages/db/src/migrations/0019_quiz_time_limit.sql`:
  ADD COLUMN + ADD CONSTRAINT with rationale-bearing header comment.
  Run scoped governance test → migration-SQL assertion green.
- [x] T4 → create `packages/db/src/migrations/meta/0019_snapshot.json`:
  copy `0018_snapshot.json`, change `id` to a fresh UUID, change
  `prevId` to 0018's id, add the `time_limit_seconds` column under
  `tables["public.quizzes"].columns` and the
  `quizzes_time_limit_range` entry under
  `tables["public.quizzes"].checkConstraints`. Run scoped
  governance test → snapshot-chain + snapshot-column +
  snapshot-check assertions green.
- [x] T5 → edit `packages/db/src/migrations/meta/_journal.json`:
  insert the idx-19 entry between 18 and 20 (spec 161 reserves
  idx 20). Run scoped governance test → journal-entry assertion
  green.
- [x] T6 → edit `apps/web/src/components/quiz/QuizRunner.tsx`: add
  the `timeLimitSeconds` prop, the `formatRemaining` helper, the
  `useEffect` countdown + auto-submit, the `submittedRef` guard, and
  the countdown banner. Run scoped governance test → desktop-runner
  assertions green.
- [x] T7 → edit `apps/web/src/components/quiz/MobileQuizRunner.tsx`:
  same shape as the desktop edit; render the countdown chip in the
  sticky header. Run scoped governance test → mobile-runner
  assertions green.
- [x] T8 → edit `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx`:
  forward `quiz.timeLimitSeconds` to both runners. Run scoped
  governance test → page-forwarding assertion green.
- [x] T9 → edit `apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx`:
  add `timeLimitSeconds` to `exportShape`; add the
  `quiz-time-limit-summary` line in the page header; update the
  schema-reference aside. Run scoped governance test → admin-page
  assertion green.
- [x] T10 → edit `apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts`:
  add `timeLimitSeconds` to `IncomingPayload`; validate `null` or
  `60..7200`; write through to `updateSet`; include in audit
  metadata. Run scoped governance test → admin-action assertions
  green.
- [x] T11 → create
  `apps/web/src/app/(authenticated)/quizzes/[slug]/history/page.tsx`:
  server component, requires login, 404 for unknown slug,
  newest-first table scoped to the current user, empty-state card,
  data-testids. Run scoped governance test → history-page
  assertions green.
- [x] T12 → edit
  `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx`:
  add the "View history" link with
  `data-testid="quiz-result-history-link"`. Run scoped governance
  test → result-page-link assertion green.
- [x] T13 → author all five spec-kit files under
  `specs/159-quiz-history-and-time-limit/`.
- [x] T14 → run the full governance suite. Confirm no regression.
  Schema delta is additive (a nullable column + a NULL-tolerant
  CHECK), the new runner prop is optional (callers that don't pass
  it stay on the legacy untimed path), the saveQuizSchema contract
  is a strict widening (extra field accepted; absent field
  unchanged), and the history page is a pure addition (no
  existing route changes shape).
- [ ] T15 (future, out of scope) → add `started_at` to
  `quiz_submissions` and surface "time taken" on the history
  table. Needs a wire-level start event from both runners (mount
  the first time the learner sees the first question) plus a
  decision on how to handle "user closed the tab without
  submitting" — separate spec with its own audit-event design.
- [ ] T16 (future, out of scope) → admin-side "best score per
  quiz per user" dashboard widget. The history page is a faithful
  index; aggregations live on a separate dashboard widget that
  can read across all quizzes for a given user.
- [ ] T17 (future, out of scope) → persist countdown state to
  the server so a page refresh doesn't reset the timer. Needs a
  server-anchored start time on `quiz_submissions` (or a
  parallel `quiz_attempts_in_progress` table) and a careful
  decision on how to handle "user closed the tab and never came
  back" — separate spec with cleanup semantics.
