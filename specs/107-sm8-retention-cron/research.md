# Research 107

## D-001 — BullMQ `repeat: { cron }` over host cron / `setInterval`

Three viable options: (a) host-level cron on the VPS that runs
`docker compose exec db-app pnpm retention`, (b) Node `setInterval`
inside the worker process, (c) BullMQ's built-in `repeat: { cron }`
scheduler. (c) wins because it (i) survives container restarts —
the schedule persists in Redis with the fixed jobId, (ii) doesn't
require provisioning a host-side crontab that's invisible to the repo,
(iii) gives the failure/retry semantics for free (default BullMQ
exponential backoff), and (iv) co-locates the schedule with the code
that handles the job, so an operator reading `apps/worker/src/index.ts`
sees both "what runs" and "when" in one file.

## D-002 — Fixed `jobId: 'retention:nightly'` for idempotent re-registration

BullMQ's `queue.add(..., { repeat, jobId })` dedupes on jobId. The
worker calls `retentionQueue.add(...)` unconditionally on boot, so if
we left jobId off, every container restart would pile up another
repeat-schedule entry in Redis and we'd start deleting four times a
day. The fixed jobId pattern is the documented BullMQ way to express
"this is *the* singleton schedule for X; overwrite any prior version."

## D-003 — Concurrency 1 for the retention Worker

The transcode Worker uses `WORKER_CONCURRENCY` (default 2) — multiple
videos can transcode in parallel. The retention Worker is hard-coded
to concurrency 1: it's a nightly maintenance job, never on the user
hot path, and two simultaneous runs would race on the same DELETE
(harmless but noisy in logs and would double-count the deleted-rows
metric). One-at-a-time is the right shape.
