# Spec 146 — Quiz grading fix (Workflow Run 13 audit-closure HIGH)

## Why

The 7-agent code audit that closes Workflow Run 13 flagged a HIGH
severity grading defect in the quiz pipeline shipped by spec 120 and
extended by spec 134 (mobile runner). The bug rendered every quiz
score systematically inflated, with the exact inflation depending on
how many questions the learner skipped.

The root cause is a mismatch between the answer set the client posts
and the question set the server grades against:

1. `QuizRunner.tsx` and `MobileQuizRunner.tsx` filter their internal
   selection state with `.filter((qq) => selected[qq.id] !== undefined)`
   BEFORE posting to the server. This silently drops every skipped
   question from the wire payload.
2. `submitQuizAttempt` in `quizzes/[slug]/page.tsx` builds an
   `answerMap` from the posted answers, then iterates `qs` (the full
   set of questions loaded from the DB) computing
   `correct / qs.length`. So far so good — the denominator IS the
   full count.
3. BUT inside the loop, the check
   `if (picked !== undefined && picked === q.correctIndex)` treats
   "client dropped this question" identically to "client included this
   question with no selection" — there is no way to detect the
   former. AND because `Math.round((correct / qs.length) * 100)` uses
   `qs.length` (the full count, correctly), the visible score for a
   learner who answered 3 of 10 correctly should be 30%. So why is
   that score wrong?

The bug surfaces when you actually walk through a scenario: a learner
answers 3 of 10 questions, all 3 correct, skips the other 7. The
client filters out the 7 skipped IDs entirely. The server's loop
finds `picked === undefined` for those 7 (because the map has no
entry) and falls through. It counts 3 correct of 10, computes 30%.

**That's actually the correct score.** Re-reading the audit finding,
the real bug is more subtle:

- The audit framing — "skipped questions = wrong score" — exaggerates.
  The arithmetic is right.
- The TRUE defect is in the **data model and trail**: there is no
  way for the result page, the audit log, or any downstream consumer
  to distinguish "answered the wrong option" from "skipped". Both
  show up identically as "no entry in the answer map". This makes
  retake coaching, audit, and analytics impossible.
- A second, real defect is that the result-page UI renders skipped
  questions with the misleading copy "No answer" but the same red ×
  icon used for genuine wrong answers — implying the learner picked
  wrong when they didn't pick at all.

Spec 146 therefore ships two changes:

1. **Wire contract** — client sends ALL question IDs, with
   `selectedIndex: null` for skipped. The server's answer-map then
   has a row for every question, and the loop can tell skipped from
   answered-wrong by checking for `null`.
2. **Result-page surface** — show "X of N answered · Y correct of N
   · Z skipped" so the learner sees the breakdown explicitly. The
   per-question card uses "Skipped" copy (italic) for null/missing
   picks instead of the old ambiguous "No answer".

The grading rule itself is unchanged: skipped counts as wrong (0
points). The learner had the chance to answer and chose not to —
same outcome as picking the wrong option for the percentage score,
but distinguishable in the trail.

## What we ship

### 1. `apps/web/src/components/quiz/QuizRunner.tsx` (EDITED)

- Widen the `submitAction` prop type so `selectedIndex: number | null`
  (was `number`).
- Rewrite the `onSubmit` body to map over the full `questions` array
  (not the filtered "answered only" subset) and emit
  `selectedIndex: null` for any question the learner skipped.

### 2. `apps/web/src/components/quiz/MobileQuizRunner.tsx` (EDITED)

- Same two changes as the desktop runner: widened prop type and full
  question list with `null` for skipped.

### 3. `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx` (EDITED)

- Widen `submitQuizAttempt`'s `answers` parameter type to
  `Array<{ questionId: string; selectedIndex: number | null }>`.
- The grading loop now tracks `answeredCount` separately from
  `correct`. The percentage is still `correct / qs.length` — skipped
  questions count as wrong against the denominator.
- The `recordAudit` metadata gains `answeredCount` so the audit log
  can distinguish "answered X / N correctly" from
  "skipped N - answeredCount".

### 4. `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx` (EDITED)

- Compute and render an "X of N answered · Y correct of N · Z skipped"
  breakdown below the pass/fail banner.
- Per-question card now treats `null` and `undefined` identically
  (both = skipped) so the result page works for both pre-146 and
  post-146 submissions in the DB.
- The "No answer" copy is replaced with the more honest "Skipped".

### 5. `packages/db/src/schema/quizzes.ts` (EDITED — type only)

- Widen `quizSubmissions.answers` `$type<>` annotation so
  `selectedIndex: number | null` (was `number`). No SQL migration —
  jsonb stores whatever shape we hand it. Pre-146 rows continue to
  store only numbers; post-146 rows mix numbers and nulls.

### 6. `tests/governance/test_134_mobile_quiz_runner.test.mjs` (EDITED)

- The spec 134 contract assertions were written against the old
  `selectedIndex: number` shape and would fail under spec 146 without
  this update. Widen both regexes to accept `number | null`.

## Acceptance criteria

- `QuizRunner.tsx` no longer calls `.filter` on its `selected` state
  before submit — every question is in the payload.
- `MobileQuizRunner.tsx` likewise emits the full question list.
- Both runners' `submitAction` prop types accept `number | null` for
  `selectedIndex`.
- `submitQuizAttempt` accepts the widened type and computes
  `answeredCount` separately from `correct`.
- The audit metadata for `quiz.submit` includes `answeredCount`.
- The result page renders the
  `data-testid="quiz-result-breakdown"` element with the answered /
  correct / skipped counts.
- The result page replaces "No answer" with "Skipped".
- The `quizSubmissions.answers` `$type<>` annotation allows
  `selectedIndex: number | null`.
- All five spec-kit files exist under `specs/146-quiz-grading-fix/`.
- `tests/governance/test_146_quiz_grading_fix.test.mjs` passes with
  at least seven assertions covering the above.

## Non-goals

- **No SQL migration.** The change is purely a type-level widening on
  a jsonb column. Existing rows continue to round-trip safely.
- **No change to the grading rule.** Skipped is still graded as
  wrong (0 points). The percentage shown to the learner does not
  change for a given (answered, correct) pair — only the breakdown
  underneath does.
- **No new audit event.** `quiz.submit` already exists; we add one
  metadata field rather than minting a new action verb.
- **No retroactive backfill.** Pre-146 submissions have only the
  answered-question entries in their `answers` array. The result
  page treats them correctly (any missing question is rendered as
  Skipped, same as a null entry would be).
- **No UI restriction on submission.** The runner still requires the
  CURRENT question to be answered to enable Next / Submit — that is
  a separate UX choice from spec 120 and is not in scope here. A
  learner can still skip questions by navigating back from a later
  one without selecting an option; that path is exactly the path
  spec 146 makes safe.
