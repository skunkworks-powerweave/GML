# Spec 120 — Quiz full stack (Workflow Run 10 frontend-parity)

**Status:** complete · **Date:** 2026-06-02 · **Phase:** Run 10 (frontend
parity closure)

## Why

The Workflow Run 10 frontend-parity audit identified six previously-DROPPED
features that ARE fully designed in the JSX prototype. The quiz runner is
the highest-value of those: `LMS GML Frontend/forms.jsx::QuizRunner`
(lines 157-266) is a 110-line, fully-styled multiple-choice flow with
progress bar, A/B/C/D options, navigation, and a result screen — but specs
079 and 080 were dropped during Phase 8 and the production app had no
`/quizzes` route, no schema, and no grader.

Spec 119 (Tier H of Run 9) already wired the *entry points* — the RTT
subject-detail page renders Start/Locked CTAs to
`/quizzes/mid-unit?subjectId=…` and `/quizzes/endline?subjectId=…`. Today
those links 404. Spec 120 lands the runner, the result page, the admin
registry, and the underlying schema so those links resolve.

## Scope

### Schema additions (migration 0014)

Three new tables in `packages/db/src/schema/quizzes.ts`:

1. **`quizzes`** — quiz metadata. `slug` UNIQUE varchar(60) routes the
   public URL (`/quizzes/<slug>`). `title` is the visible heading.
   `subject_id` and `rtt_subject_id` are nullable FKs with a CHECK
   constraint asserting exactly one is set. `pass_threshold` smallint
   (default 60) drives the pass/fail banner. `active` boolean +
   `created_at`/`updated_at` timestamps.

2. **`quiz_questions`** — ordered multiple-choice items. `quiz_id` FK
   cascades on delete. `sequence` integer + `(quiz_id, sequence)` unique
   index keeps display order deterministic. `prompt` text, `options`
   jsonb array of strings, `correct_index` smallint (0-based into
   options), `explanation` text (nullable).

3. **`quiz_submissions`** — graded attempts. `quiz_id` + `user_id` FKs
   cascade. `answers` jsonb is the per-question record
   `[{ questionId, selectedIndex }]`. `score` smallint 0-100 (with CHECK
   range) and `passed` boolean computed at insert. `submitted_at`
   defaults to `now()`. Indexes on `(user_id, submitted_at)` and
   `(quiz_id, submitted_at)` keep history and analytics fast.

### Routes

- **`/quizzes/[slug]`** — server component loads the quiz + ordered
  questions. Renders the JSX prototype's header (label, serif title,
  question-count chip, progress bar, "x / y" counter) and hands the
  questions to `<QuizRunner>` (`"use client"`). Submit triggers the
  `submitQuizAttempt(slug, answers)` server action.

- **`/quizzes/[slug]/result/[submissionId]`** — server component shows
  the score percentage, pass/fail banner with the quiz's threshold,
  per-question correct/incorrect breakdown with explanations, and
  Retake/Continue CTAs. SM-9 light gate: only the submission owner can
  view their result.

- **`/admin/quizzes`** — index of quizzes (server component, gated to
  programme_admin + super_admin). Mirrors `/admin/forms` (spec 073) —
  table with title, slug, scope chip, question count, pass threshold,
  active state, edit link.

- **`/admin/quizzes/[id]`** — JSON editor. Server fetches the row +
  questions, hydrates a `'use client'` `<QuizSchemaEditor>`. Editor PUTs
  through a server action (`saveQuizSchema`) defined in `./actions.ts`.

### Grading

`submitQuizAttempt`:
- Authenticated (redirects to /login otherwise).
- Loads quiz by slug, redirects on inactive/missing.
- Computes score = `round((correct / total) * 100)` (integer 0-100).
- `passed = score >= passThreshold`.
- Inserts `quiz_submissions` row with full answer record.
- Records `quiz.submit` audit with `{ quizSlug, score, passed,
  questionCount }`.
- Redirects to `/quizzes/[slug]/result/[submissionId]`.

`saveQuizSchema` (admin):
- Authenticated + role-gated server-side.
- Validates JSON parses + every question has prompt, ≥ 2 options, and a
  valid `correctIndex`.
- Replaces all `quiz_questions` rows for the quiz in a transaction
  (idempotent for v1).
- Records `quiz.schema.update` audit.

## Acceptance criteria → JSX components ported

| JSX (forms.jsx::QuizRunner) | Server counterpart |
| --- | --- |
| `window.LMS.QUIZ` hard-coded | `quizzes` + `quiz_questions` tables |
| Progress bar + x/y counter | Same, rendered server-side header |
| A/B/C/D options w/ `String.fromCharCode(65 + i)` | Same in `<QuizRunner>` client |
| `score = answers.reduce(...)` client-side | `submitQuizAttempt` server action |
| Inline `done` state | Dedicated `/result/[submissionId]` page |
| Retake / Continue buttons | `<Link>` to runner / dashboard |

## Audit hooks

- **`quiz.submit`** — written on every successful `submitQuizAttempt`.
  Metadata: `{ quizSlug, score, passed, questionCount }`.
- **`quiz.schema.update`** — written on every successful
  `saveQuizSchema`. Metadata: `{ questionCount, title?, passThreshold?,
  active? }`.

## Out of scope (deferred to future specs)

- Subject/rtt_subject seed data (none yet — admins create via SQL or the
  JSON editor on the detail page; the index page renders a friendly
  empty state).
- Visual question-by-question editor (raw textarea ships in v1; same
  rationale as spec 073).
- Quiz creation UI (admins seed via SQL until the create flow lands;
  index page surfaces this as a chip note).
- Multi-attempt rate-limiting (any authenticated user can retake
  unlimited times; we record every submission).
- Question images, scale items, multi-select — all v2 enhancements.
- Hindi-language quiz prompts (Devanagari path is already supported by
  the var(--deva) token family but not wired in v1).

## Non-goals

- No API route — admin save uses a Server Action (`saveQuizSchema`),
  which is the canonical pattern shipped by Phase 8.
- No new dependencies. Pure Drizzle + Next.js Server Actions.
- No new audit_log columns — the existing varchar(64) action column
  carries `quiz.submit` / `quiz.schema.update` dotted-notation strings.
