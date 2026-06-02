# Quickstart 151 — Worker hardening

Three manual smoke checks, each ~3 minutes. All require the docker-compose
stack (web + db + redis + minio + worker) to be running locally.

## (A) Retry policy — transcode queue

1. Boot `docker compose up -d` and confirm worker logs show
   `[worker] online · redis=redis://redis:6379 · concurrency=2`.
2. Open a Redis CLI: `docker compose exec redis redis-cli`.
3. Inspect queue defaults — BullMQ writes them to a `meta` key:
   ```
   HGETALL bull:transcode:meta
   ```
   You should see `opts` containing the `attempts`, `backoff`,
   `removeOnComplete`, `removeOnFail` you set in `queues.ts`.
4. Force a transcode failure: temporarily break MinIO by running
   `docker compose stop minio`. Upload a small video via the mentor
   UI. The transcode job will fail (MinIO unreachable). Watch the
   worker logs — you should see THREE attempts with exponential
   delays before the job lands in the failed set:
   ```
   [worker] job 1 failed: ... (1st attempt, retry in ~5s)
   [worker] job 1 failed: ... (2nd attempt, retry in ~10s)
   [worker] job 1 failed: ... (3rd attempt, final)
   ```
5. Bring MinIO back up: `docker compose start minio`. Re-upload the
   same video — first-attempt success this time.

## (B) Concurrency clamp

6. Stop the worker: `docker compose stop worker`.
7. Try each of these envs in `.env` and `docker compose up worker`:
   - `WORKER_CONCURRENCY=0` — startup log reads `concurrency=2`
     (clamped up from 0).
   - `WORKER_CONCURRENCY=foo` — startup log reads `concurrency=2`
     (NaN → 2 via the `|| 2` fallback).
   - `WORKER_CONCURRENCY=999` — startup log reads `concurrency=16`
     (clamped down).
   - `WORKER_CONCURRENCY=4` — startup log reads `concurrency=4`
     (in-range, passed through).
   - (unset) — startup log reads `concurrency=2` (default).
8. Confirm the worker actually processes jobs at the resolved
   concurrency: with `WORKER_CONCURRENCY=4`, queue 5 transcode
   jobs back-to-back. The first four start in parallel
   (`docker compose logs worker -f` shows four `picking job …`
   lines within a second of each other); the fifth waits for one
   to finish.

## (C) Cron timezone documentation

9. Read `apps/worker/src/index.ts` around the `retentionQueue.add(...)`
   call. The comment block above the call should mention:
   - server-local TZ,
   - production = UTC,
   - 03:00 UTC = 08:30 IST,
   - `TZ` env override.
10. Inspect the registered schedule via Redis CLI:
    ```
    KEYS bull:retention:repeat:*
    ```
    A single key matching `retention:nightly` should exist. The
    `next` field stores the next-run epoch in MS. Convert with
    `date -d @<seconds>` to verify it's ~03:00 UTC tomorrow.
11. (Optional, only if curious) Override the worker timezone:
    add `TZ=Asia/Kolkata` to the worker service in `docker-compose.yml`,
    `docker compose up -d worker`. The next `KEYS bull:retention:repeat:*`
    inspection should show the next-run shifted by 5:30h.

## Test gate

12. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 151"
    ```
    All assertions green. Full suite still 1197 / 1197 (this spec
    adds new tests; no edits to existing ones).

## What we did NOT verify here

- **Actual retry behaviour under runtime load**: BullMQ retries are
  exercised in step 4 above, but the governance test pins the
  SOURCE shape (attempts: 3, backoff exponential, removeOn* present)
  rather than asserting on observed retry counts. Runtime
  verification is the operator's smoke test, not CI.
- **Wall-clock cron firing**: we don't wait for 03:00 UTC to verify
  the nightly purge runs. Spec 107's governance test already covers
  that `deleteOldNotifications` runs when the cron fires; this spec
  only adds the timezone documentation.
