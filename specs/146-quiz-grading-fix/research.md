# Research 146 — Quiz grading fix

## The audit finding

Workflow Run 13's 7-agent audit logged a HIGH severity finding
against the spec 120 / spec 134 quiz pipeline:

> Quiz grading bug. Client filters answers to "answered only" before
> submit. Server grades against all questions in DB. Skipped questions
> = wrong score.

Reading the code carefully, the "wrong score" framing is slightly
overstated — the percentage arithmetic IS correct as shipped:

- `correct` is incremented only when the picked answer matches.
- The denominator is `qs.length` (the FULL question count from the
  DB), not `answers.length` (the partial payload).
- So a learner who answers 3 of 10 correctly genuinely gets 30%.

But the deeper concern is real:

1. **No audit trail of skipped vs wrong.** Both manifest server-side
   as "no entry in the answer map". A coach trying to remediate
   cannot tell which.
2. **No result-page distinction.** The UI renders skipped questions
   with the misleading copy "No answer" alongside a red × — implying
   the learner picked wrong when they didn't pick at all.
3. **Defense-in-depth.** If a future refactor changes the denominator
   to `answers.length` (an easy mistake — "let's just iterate the
   posted answers") the inflation bug becomes real. Sending the full
   question list with explicit null markers is the safer wire shape
   regardless.

Spec 146 closes all three.

## Why `selectedIndex: number | null` (not `-1` sentinel or absent)

Three candidate shapes for "skipped":

| Shape | Pro | Con |
|---|---|---|
| Absent from map | matches today's behaviour | indistinguishable from a wire bug |
| `selectedIndex: -1` | always-number type | sentinel value collides with future "I don't know" answer option indices |
| `selectedIndex: null` | semantic, no sentinel | jsonb column already nullable-friendly |

We pick `null`. It maps cleanly to the JS `null` literal at the
client, JSON.stringifies as `null` (not `undefined`, which would be
dropped silently), survives the round-trip through jsonb, and the TS
type widening to `number | null` is minimal and forces every read
site to add the null check.

## Why "skipped counts as wrong" (and not "skipped excludes from total")

Two policy options:

- **A. Skipped counts as wrong** — percentage = `correct / total`,
  so a learner who answers 3 of 10 correctly and skips 7 gets 30%.
- **B. Skipped excludes from total** — percentage = `correct / answered`,
  so the same learner gets 100%.

We pick **A**. Reasons:

- The learner had the chance to answer and chose not to. From an
  assessment perspective that is equivalent to picking the wrong
  option — they don't know it.
- Option B trivially games passing thresholds. A learner who only
  answers the questions they're confident about always passes.
- The seed quiz set assumes A — `passThreshold` is set against the
  full question count.
- This matches the audit instruction: "best practice is 'skipped
  counts as wrong' because user had the chance".

We document this in `spec.md` and in the inline comment on the
grading loop so the next reader doesn't have to re-derive it.

## Why no SQL migration

`quiz_submissions.answers` is a jsonb column. Jsonb stores arbitrary
JSON values per row. Widening the TS `$type<>` annotation from
`Array<{ ..., selectedIndex: number }>` to
`Array<{ ..., selectedIndex: number | null }>` changes only what TS
compiles — the bytes in the column are unaffected.

Pre-146 rows already contain only the answered-question entries.
Post-146 rows contain every question entry with explicit null for
skipped. The result page handles both shapes correctly because the
"is this answered?" check is `picked !== undefined && picked !== null`
— which is true for both "absent from map" and "present as null".

There is no need for a backfill either. The `score` and `passed`
columns on each pre-146 row remain correct because the original
grading logic happened to compute them against `qs.length`, not the
shortened answer list. The only thing pre-146 rows can't do is
distinguish skipped from wrong on the result page — which is
acceptable for historical attempts.

## Cross-spec impact

- `tests/governance/test_120_quiz_full_stack.test.mjs` — does NOT
  pin the `selectedIndex` type. Unaffected.
- `tests/governance/test_134_mobile_quiz_runner.test.mjs` — pins
  `selectedIndex: number` exactly in two places. Updated to accept
  `number | null`. The intent of the assertions (mobile / desktop
  contracts stay in sync) is preserved.
- `packages/db/src/schema/quizzes.ts` — TS-only widening.
- Result page handles legacy rows transparently. No data migration
  needed.

## Why not loosen the runner's "answer current question to advance" guard

The runner today disables Next / Submit if the current question has
no selection. This is a separate UX choice from spec 120. A learner
can still skip questions by navigating back from a later question
without selecting one — and that path is the path spec 146 makes
safe. Loosening the guard further is out of scope; it would change
the runner's learning posture without affecting the grading bug.

## Affected files (final list)

- `apps/web/src/components/quiz/QuizRunner.tsx` (desktop runner)
- `apps/web/src/components/quiz/MobileQuizRunner.tsx` (mobile runner)
- `apps/web/src/app/(authenticated)/quizzes/[slug]/page.tsx`
  (server action + page shell)
- `apps/web/src/app/(authenticated)/quizzes/[slug]/result/[submissionId]/page.tsx`
  (result page)
- `packages/db/src/schema/quizzes.ts` (type widening)
- `tests/governance/test_134_mobile_quiz_runner.test.mjs`
  (assertion widening so spec 134 still pins the contract)
- `tests/governance/test_146_quiz_grading_fix.test.mjs` (new)
- `specs/146-quiz-grading-fix/*.md` (spec-kit, five files)
