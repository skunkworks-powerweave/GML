# Quickstart 162 — Transcode DLQ admin view

Five-minute manual smoke. Requires the docker-compose stack
(`web` + `worker` + `db` + `redis` + `minio`) running and a
`super_admin` or `programme_admin` account seeded.

## (A) Surface renders and reads queue depth

1. Boot the stack:
   ```
   docker compose up -d
   pnpm --filter @gml/web dev
   ```
2. Sign in as a `super_admin` user. Navigate to `/admin`. Confirm
   the System section now has a "Transcode jobs" card.
3. Click through to `/admin/transcode-jobs`. The page renders with:
   - Top strip showing Waiting / Active / Delayed / Failed counts
     (probably all zero on a fresh stack).
   - Filter pills: All / Failed / In progress / Queued / Recent (24h).
   - Empty table with "No transcode jobs match the current filter."

## (B) Failed-row Retry verb

4. Trigger a transcode failure to populate the DLQ. The easiest
   path on a dev stack:
   ```
   psql $DATABASE_URL -c "
   INSERT INTO transcode_jobs (video_submission_id, profile, status, error)
   SELECT id, '480p', 'failed', 'synthetic failure for quickstart 162'
   FROM video_submissions
   ORDER BY created_at DESC LIMIT 1;
   "
   ```
5. Reload `/admin/transcode-jobs`. The new row appears at the top
   (failed-first sort). Status chip reads "failed". The Retry +
   Drop buttons render under Actions.
6. Click "Retry". The page reloads on a redirect. The failed row
   is still visible (worker hasn't picked it up yet), but a new
   row will appear with status='running' or 'succeeded' once the
   worker processes the queue.
7. Open `/admin/audit?action=transcode.retry_requested`. The
   audit row is there with metadata carrying `previousStatus`,
   `videoSubmissionId`, `bucket`, `objectKey`, `source`.

## (C) Failed-row Drop verb

8. Manufacture another failed row (repeat step 4 with a different
   submission).
9. Click "Drop". Page reloads. The row's status chip now reads
   "dropped" (chip-indigo, not chip-rust).
10. The Retry + Drop buttons are gone — the row is terminal-
    non-actionable.
11. Check the parent video_submission:
    ```
    psql $DATABASE_URL -c "SELECT id, status FROM video_submissions WHERE id = '<copied-uuid>';"
    ```
    The submission status is now `failed` (the drop verb flips
    the parent so the videos library tells the truth).
12. `/admin/audit?action=transcode.dropped` shows the drop row
    with metadata `previousStatus`, `videoSubmissionId`,
    `bullJobId`.

## (D) Filter pills drive the URL

13. From `/admin/transcode-jobs`, click "Failed". URL becomes
    `/admin/transcode-jobs?filter=failed`. The table shrinks to
    failed-only rows. The Failed pill is highlighted (dark
    background, white text, `aria-current="page"`).
14. Click "Recent (24h)". URL becomes
    `/admin/transcode-jobs?filter=recent`. Shows only jobs
    `createdAt >= now() - 24h`.
15. Click "All" (or use the Reset behaviour — All has no query
    param). Table returns to full view.

## (E) Role gate

16. Sign in as a `teacher` (or any non-admin role). Navigate to
    `/admin/transcode-jobs`. The page must redirect to
    `/forbidden` (or `/login` if not signed in).
17. As `programme_admin`, the page renders. As `super_admin`, the
    page renders.

## (F) Redis-down graceful degradation

18. Stop the redis container:
    ```
    docker compose stop redis
    ```
19. Reload `/admin/transcode-jobs`. The top strip should now show
    "Live queue depth unavailable (Redis unreachable)." The table
    still renders (DB is unaffected).
20. Restart redis (`docker compose start redis`). Reload. Top strip
    re-populates.

## Test gate

21. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 162"
    ```
    All assertions green. Full suite still passes
    (1295 / 1295 pre-spec).
