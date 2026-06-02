# Quickstart 159 — Quiz time limit + attempts history

Three manual smoke checks plus the migration. Total ~8 minutes.

## (A) Migration

1. Boot `pnpm dev` + the docker-compose db / redis / minio.
2. Run the migration:
   ```bash
   pnpm --filter @gml/db migrate
   ```
3. Confirm the column + constraint:
   ```sql
   \d quizzes
   -- look for: "time_limit_seconds" integer
   --           Check constraints:
   --             "quizzes_time_limit_range" CHECK (time_limit_seconds IS NULL OR ...)
   ```
4. Verify a value out of range is refused:
   ```sql
   UPDATE quizzes SET time_limit_seconds = 30 WHERE slug = '<a-seed-slug>';
   -- expected: ERROR: new row for relation "quizzes" violates check
   --           constraint "quizzes_time_limit_range"
   UPDATE quizzes SET time_limit_seconds = 600 WHERE slug = '<a-seed-slug>';
   -- expected: 1 row updated.
   ```

## (B) Time-limit countdown (desktop)

5. Sign in as a learner who has access to the timed quiz.
6. Visit `/quizzes/<slug>`. The runner shows a "Time remaining 09:60"
   banner under the page header (mono font, paper background).
7. Wait ~9 minutes (or temporarily set `time_limit_seconds = 90` for
   the smoke test).
8. As the countdown crosses 00:59 the banner shifts to `var(--rust)`
   (red border, rust text). The countdown keeps ticking visibly.
9. At 00:00 the runner fires the submit action automatically. Browser
   redirects to `/quizzes/<slug>/result/<id>`. The result page shows
   the score and breakdown (every unanswered question shows up as
   "Skipped" per the spec 146 contract).

## (C) Time-limit countdown (mobile)

10. Set `gml-device=mobile` cookie OR resize the browser to ≤ 768 px.
11. Visit `/quizzes/<slug>`. The mobile runner shows a small mono
    chip in the sticky header carrying the time remaining (e.g.
    "08:42") right next to the "1 / N" counter.
12. Same behaviour as desktop — chip turns rust under 60s, auto-
    submits at 00:00.

## (D) Time-limit input — admin editor

13. Sign in as `programme_admin` or `super_admin`.
14. Visit `/admin/quizzes/<id>` for any quiz.
15. The page header shows a "time limit: untimed" line (mono, under
    the pass-threshold readout) for legacy quizzes; for timed quizzes
    it shows "time limit: 10m" (or "10m 30s" if a non-multiple-of-60
    value was set).
16. In the JSON editor, add `"timeLimitSeconds": 600` to the payload.
    Click Save. The save status shows "Saved · N questions" and the
    page header re-renders with "time limit: 10m".
17. Try saving `"timeLimitSeconds": 30`. The save status shows
    `invalid_time_limit · timeLimitSeconds must be null (untimed) or
    an integer between 60 (1 min) and 7200 (2 h).`
18. Try saving `"timeLimitSeconds": null`. The save succeeds and the
    page header reverts to "time limit: untimed".

## (E) Quiz history page

19. As any logged-in learner, take a quiz at least once.
20. Open the result page after submitting. The button row at the
    bottom now shows three actions: Retake, View history, Continue.
21. Click "View history". The page renders at
    `/quizzes/<slug>/history`. It shows a table with the columns
    Submitted, Score, Result, and a "View result" link per row.
22. Take the quiz again. The history page now shows two rows,
    newest-first.
23. Click "View result" on any row. The result page renders for that
    submission. (The same per-user gate from spec 120 applies — a
    second user can't view the first user's submission.)
24. As a learner who has NEVER taken the quiz, visit the history
    page directly: `/quizzes/<slug>/history`. The page renders the
    empty-state card with a "Start the quiz" CTA.

## (F) 404 / per-user gate

25. Visit `/quizzes/non-existent-slug/history`. The page returns the
    Next.js 404.
26. Open a learner's history URL in a different learner's browser:
    the page renders the empty state (other-user submissions
    aren't visible — the WHERE clause is `user_id = me`).

## Desktop / mobile parity check

27. Verify the mobile shells (specs 137-138) still render the
    history page. Resize to ≤ 768 px or set the `gml-device=mobile`
    cookie. The table renders with reasonable wrapping — the
    columns collapse to a stacked layout on narrow widths via the
    existing `card-hi` styles.

## Test gate

28. Run the scoped governance suite:
    ```bash
    pnpm test -- --test-name-pattern "spec 159"
    ```
    All assertions green. Full suite still passes — the schema delta
    is additive (a nullable column + CHECK constraint), the new
    page is a SELECT against an existing index, and the editor
    contract is widened (the old payload shape — without
    `timeLimitSeconds` — still parses and writes through unchanged).
