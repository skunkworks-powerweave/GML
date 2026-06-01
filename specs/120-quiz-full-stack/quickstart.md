# Quickstart 120

## Run the migration

```bash
pnpm --filter @gml/db migrate
```

## Seed a quiz via SQL (until the create UI ships)

```sql
-- 1) Pick a subject id
SELECT id FROM subjects LIMIT 1;

-- 2) Create the quiz
INSERT INTO quizzes (slug, title, subject_id, pass_threshold)
VALUES ('mid-unit-demo', 'Mid-unit check — Demo', '<subject-id>', 60)
RETURNING id;

-- 3) Add two questions
INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index, explanation)
VALUES
  ('<quiz-id>', 1, 'What is 2 + 2?', '["3","4","5","6"]'::jsonb, 1, 'Basic arithmetic.'),
  ('<quiz-id>', 2, 'What colour is the sky on a clear day?', '["red","blue","green","yellow"]'::jsonb, 1, 'Rayleigh scattering.');
```

## Take the quiz

1. Sign in as any authenticated user.
2. Navigate to `/quizzes/mid-unit-demo`.
3. Pick an option per question, click **Next**, then **Submit answers**
   on the last question.
4. The result page renders at `/quizzes/mid-unit-demo/result/<id>` with
   per-question correct/incorrect breakdown and pass/fail banner.

## Edit a quiz

Sign in as `programme_admin` and visit `/admin/quizzes`. Click any row to
open the JSON editor; the payload shape matches the schema reference at
the bottom of the detail page. **Save** validates the JSON and replaces
all questions in a single transaction — the change lands in
`audit_log` with action `quiz.schema.update`.

## Inspect the audit trail

```sql
SELECT action, metadata, created_at
FROM audit_log
WHERE action IN ('quiz.submit', 'quiz.schema.update')
ORDER BY created_at DESC
LIMIT 20;
```
