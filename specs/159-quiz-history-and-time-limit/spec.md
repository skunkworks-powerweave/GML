# Spec 159 — Quiz attempts history + per-quiz time limit (Workflow Run 15 audit closure, MISS)

## Why

Workflow Run 14 closed the CRITICAL / HIGH / MEDIUM audit findings on the
quiz pipeline (commits ee3991e + 744ae62). The seven-agent audit at the
close of Run 14 logged one remaining feature MISS:

> The quiz schema has no notion of a per-attempt time limit, and the
> result surface has no way to view a learner's prior attempts. Both are
> gaps versus the original product brief — formative assessments are
> fine untimed but the eventual summative quizzes will need a cap, and
> learners who retake a quiz today have no way to look back at how they
> did the first time without scraping the audit log.

This spec closes both halves of that MISS in one ledger entry. Each half
is independently shippable but they share the same touched files (the
quiz runner + the quiz pages), so consolidating them keeps the ledger
and the migration index compact.

### 1. Time limit on quizzes

`packages/db/src/schema/quizzes.ts` has `passThreshold` but no time
limit. The seed catalogue ships only untimed quizzes; the audit MISS
flags this for the eventual summative assessments. Adding the column
NULLABLE with a DB-layer CHECK constraint (60..7200) means every legacy
quiz stays untimed by default, the editor opts in per-quiz, and the
range is enforced at three layers (DB CHECK, server-action validation,
TypeScript inferred type).

The desktop and mobile runners need to:

- Show a mono-font countdown banner ("08:42 remaining") when the quiz
  has a time limit, switching to `var(--rust)` under 60 seconds left.
- Auto-submit whatever state has been collected at 00:00 using the
  same wire shape the manual submit uses — every unanswered question
  carries `selectedIndex: null` per the spec 146 grading contract.
- Tear the timer down on unmount so the interval doesn't leak across
  navigation.

### 2. Quiz attempts history

`/quizzes/[slug]/result/[submissionId]` shows ONE submission at a time.
A learner who retakes a quiz three times has three result URLs (the IDs
appear in audit metadata and in dashboard nudges), but no consolidated
view of how their attempts compare. This page closes the gap.

The page is server-rendered, scoped to the current user (no
cross-user joins), and lists submissions newest-first. Each row carries
the submitted date/time, score, pass/fail badge, and a link to the
per-attempt result page. The existing `quiz_submissions_user_idx`
(user_id, submitted_at) shipped in spec 120 means this query is an
index range scan, not a seqscan.

## What we ship

### `packages/db/src/schema/quizzes.ts` (EDITED)

- Adds `timeLimitSeconds: integer("time_limit_seconds")` to the
  `quizzes` table. NULLABLE — every legacy row stays untimed.
- Adds a `check("quizzes_time_limit_range", ...)` constraint enforcing
  `time_limit_seconds IS NULL OR time_limit_seconds BETWEEN 60 AND 7200`.
- Inline Spec 159 comment block above the new column documents the
  rationale (NULL = untimed, range bounds chosen for UX-floor +
  long-form-ceiling).

### `packages/db/src/migrations/0019_quiz_time_limit.sql` (CREATED)

- `ALTER TABLE "quizzes" ADD COLUMN "time_limit_seconds" integer;` and
  `ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_time_limit_range" CHECK (...)`.
- Header comment documents the rationale (audit MISS, range choices,
  why NULL preserves the legacy quiz behaviour) and notes this is the
  Workflow Run 15 audit-closure MISS for quizzes.

### `packages/db/src/migrations/meta/0019_snapshot.json` (CREATED)

- Carry-forward of `0018_snapshot.json` with:
  - Fresh `id` UUID, `prevId` chains off 0018's id.
  - `public.quizzes.columns` gains a `time_limit_seconds` integer
    (notNull: false, no default).
  - `public.quizzes.checkConstraints` gains
    `quizzes_time_limit_range`.

### `packages/db/src/migrations/meta/_journal.json` (EDITED)

- New entry between idx 18 and idx 20 (idx 20 is reserved for spec
  161's password-reset migration shipping in parallel):
  - `idx: 19`, `tag: "0019_quiz_time_limit"`, `when` timestamp
    sequenced after 0018's and before 0020's.

### `apps/web/src/components/quiz/QuizRunner.tsx` (EDITED)

- Adds an optional `timeLimitSeconds?: number | null` prop.
- Adds a `formatRemaining(s)` helper that renders seconds as MM:SS.
- Adds a `useEffect` that mounts a `setInterval` countdown when
  `timeLimitSeconds` is set; on 00:00 fires the same
  `submitAction(slug, answers)` shape the manual click uses (every
  unanswered question carries `selectedIndex: null` per spec 146).
- A `submittedRef` makes the auto-submit + manual-submit paths
  mutually exclusive — a race at the 0-second boundary fires exactly
  one server action.
- Renders a `data-testid="quiz-countdown"` banner under the page
  header when `remaining` is non-null. Banner shifts to
  `var(--rust)` under 60s.
- Inline Spec 159 comments at every touched site so a future
  refactor knows to consult this spec.

### `apps/web/src/components/quiz/MobileQuizRunner.tsx` (EDITED)

- Same shape as the desktop runner: new prop, helper, effect,
  submittedRef. The countdown chip lives in the sticky header next
  to the question counter (rather than in a separate banner) so the
  narrow mobile shell doesn't lose vertical real estate.
- Data-testid is `mobile-quiz-countdown` (consistent with the
  existing `mobile-quiz-*` family).

### `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx` (EDITED)

- Resolves `quiz.timeLimitSeconds` from the DB row and passes it to
  both `<QuizRunner>` and `<MobileQuizRunner>` via the new prop.

### `apps/web/src/app/(authenticated)/admin/quizzes/[id]/page.tsx` (EDITED)

- The `exportShape` returned to the JSON editor now carries
  `timeLimitSeconds: row.timeLimitSeconds` (NULL or an integer).
- A "time limit: Nm Xs" summary renders in the page header next to
  the pass-threshold readout, with `data-testid="quiz-time-limit-summary"`.
- The schema-reference aside text below the editor calls out the
  field's contract (`null` = untimed; otherwise 60..7200).

### `apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts` (EDITED)

- `IncomingPayload` gains `timeLimitSeconds?: number | null`.
- `saveQuizSchema` accepts `null` (clear the limit) or an integer in
  [60, 7200]. Out-of-range values return
  `{ ok: false, error: "invalid_time_limit", message: ... }` rather
  than silently dropping the field.
- `updateSet.timeLimitSeconds` is written through to the
  transaction so the DB row picks up the new (or cleared) value.
- The audit metadata for `quiz.schema.update` includes
  `timeLimitSeconds` so the audit reader can see when an editor
  changed the cap.

### `apps/web/src/app/(authenticated)/quizzes/[slug]/history/page.tsx` (CREATED)

- Server component, requires a logged-in user.
- Resolves the quiz by slug; 404 if no such quiz.
- Selects from `quiz_submissions` `WHERE quiz_id = ? AND user_id = ?
  ORDER BY submitted_at DESC` (rides the existing
  `quiz_submissions_user_idx`).
- Renders an accessible role="table" grid with columns: Submitted,
  Score, Result, View-link. Empty state renders a "no attempts yet"
  card with a CTA back to the runner.
- `data-testid="quiz-history-table"` on the populated state and
  `data-testid="quiz-history-empty"` on the empty state.

### `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx` (EDITED)

- The action-button row at the bottom of the result card adds a
  "View history" `<Link>` to `/quizzes/[slug]/history`, with
  `data-testid="quiz-result-history-link"`.

## Acceptance criteria

- `packages/db/src/schema/quizzes.ts` exports `timeLimitSeconds` on
  the `quizzes` table with the CHECK constraint
  `quizzes_time_limit_range`.
- `0019_quiz_time_limit.sql` contains both the `ADD COLUMN` and the
  `ADD CONSTRAINT ... CHECK (...)` statements.
- `0019_snapshot.json` declares `time_limit_seconds` under
  `tables["public.quizzes"].columns` and declares
  `quizzes_time_limit_range` under `tables["public.quizzes"].checkConstraints`.
- `0019_snapshot.json.prevId` equals `0018_snapshot.json.id`.
- `_journal.json` carries a `0019_quiz_time_limit` entry with
  `idx: 19` sequenced between 18 and 20.
- `QuizRunner.tsx` and `MobileQuizRunner.tsx` accept
  `timeLimitSeconds?: number | null` and render the countdown
  banner (data-testid `quiz-countdown` / `mobile-quiz-countdown`)
  when the prop is non-null.
- Both runners auto-submit at 00:00 via the same `submitAction`
  wire shape used on click.
- `/quizzes/[slug]/page.tsx` passes `quiz.timeLimitSeconds` to both
  runners.
- `saveQuizSchema` accepts and validates `timeLimitSeconds`,
  returning `invalid_time_limit` for out-of-range values.
- `/quizzes/[slug]/history/page.tsx` exists, server-renders the
  current user's submissions newest-first, and links each row to
  the per-submission result page.
- The result page (`/quizzes/[slug]/result/[submissionId]/page.tsx`)
  includes a "View history" link to `/quizzes/[slug]/history`.
- All five spec-kit files exist under
  `specs/159-quiz-history-and-time-limit/`.
- `tests/governance/test_159_quiz_history_and_time_limit.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No "best score" / streak summary on the history page.** The page
  is a faithful index of `quiz_submissions` rows; aggregations
  (best score, most recent pass date) are a separate concern that
  can ship as a dashboard widget if usage warrants. Keeping this
  page columnar makes the audit + future export story trivial.
- **No client-side persistence of countdown state.** A page refresh
  during a timed attempt restarts the timer from the original
  `timeLimitSeconds`. Persisting countdown state across refresh
  would invite an exploit ("refresh whenever the timer gets low")
  unless we anchored the start time server-side — which is a
  separate spec.
- **No "started_at" tracking on quiz_submissions.** The audit asked
  for "time taken from createdAt → submittedAt"; the schema does
  not currently track a separate start timestamp (only
  submitted_at). Surfacing "time taken" would require a second
  column AND a wire-level start event from the runner — both out of
  scope for an audit-closure MISS. The history page renders the
  submission time and the score; future work can add an attempt-
  duration column once we have a clear start-event contract.
- **No CONCURRENTLY on the ADD COLUMN / ADD CONSTRAINT.** The
  drizzle-kit migrate runner wraps each migration in a transaction;
  CONCURRENTLY is incompatible with transactional DDL. At the
  current ~5-quiz scale the brief lock is invisible.
- **No new dependencies.** The fix is pure standard-library:
  setInterval, Math.floor, Date.toISOString — no calendar lib, no
  date-fns, no zod (validation is inline in the existing
  server-action shape).
