# Spec 107 — SM-8 Retention Cron (Workflow Run 7 Tier D1)

## Why

SM-8 in the substrate moat says "notifications retained ≤ 90 days." Spec
025 landed the script (`packages/db/src/scripts/retention.ts`) that does
the delete, plus a `pnpm --filter @gml/db retention` package.json entry
point, plus a governance test that asserted both exist. That was enough
to pass CI but it was never enough to actually *enforce* SM-8 in
production. The script's docstring even admits it: "Wired to a daily
BullMQ scheduled job in spec 039. For now, callable via … IT can also
schedule it via host cron until the worker is live." Spec 039 landed the
BullMQ worker (it processes `transcode` jobs) but never came back to
attach the retention scheduler. Result: the only way SM-8 was being met
on the running cluster was if the IT operator remembered to set up a
host-level cron — which, against a Ladakh deployment with limited
DevOps coverage, is the same as "it isn't being met." Notifications
would grow unbounded, the `notifications_created_idx` would bloat, and
the inbox API would gradually slow down. The deployment audit (Workflow
Run 7) flagged this as Tier D1 — operational hardening, must close
before launch.

## What

Two changes, both small and surgical:

1. **`packages/db/src/scripts/retention.ts`** is refactored from a
   "top-level `main()` then unconditional `main().catch(...)`" CLI script
   into a module that exports `deleteOldNotifications()` (the actual work
   — opens a `pg.Pool`, deletes rows where `createdAt < now()-90d`,
   closes the pool, returns the row count) plus an entry-point guard
   that preserves CLI behaviour (`tsx retention.ts` still works,
   importing the module does not auto-run). This is the same dual-purpose
   pattern spec 104 applied to the five seed scripts.
   - Also fixes a pre-existing import-path typo: `../src/schema/notifications`
     → `../schema/notifications`. The file is at
     `packages/db/src/scripts/retention.ts`, so the typo would have
     resolved to `packages/db/src/src/schema/notifications`, which would
     crash on first import. The reason the test never caught it: the
     spec-025 governance test only `read`s the file as text and matches
     regexes — it doesn't actually execute the script.

2. **`packages/db/src/index.ts`** re-exports `deleteOldNotifications` so
   the worker can `import { deleteOldNotifications } from "@gml/db"`
   instead of reaching into the internal `./scripts/retention` path
   (which the package's `exports` map doesn't expose).

3. **`apps/worker/src/index.ts`** gets a second BullMQ Queue + Worker
   pair plus a startup-time `add(..., { repeat: { cron: '0 3 * * *' },
   jobId: 'retention:nightly' })` call. The Queue is named `retention`,
   the job name is `deleteOldNotifications`, and the Worker's processor
   function calls the imported `deleteOldNotifications()` (returning
   `{ deleted: number }`). Concurrency is hard-coded to 1 — this is a
   nightly maintenance job, two concurrent runs would race on the same
   DELETE.

## Why cron, why 03:00, why a fixed jobId

- **Cron over `every:` ms** — `every: 86_400_000` would drift relative
  to wall-clock (each run schedules the next from when *this* run
  finished, not from a fixed boundary). Cron pins it to 03:00 server
  local. The deployment runs in Asia/Kolkata, so 03:00 IST = lowest
  inbox-API and lowest WhatsApp-fetch load (mentors aren't online,
  teachers haven't started morning uploads).
- **Fixed `jobId: 'retention:nightly'`** — BullMQ dedupes
  `queue.add(..., { jobId })` calls on the jobId. That means the worker
  can call `add(...)` on every boot (which it does — see the bottom of
  `apps/worker/src/index.ts`) without piling up a new repeat-schedule
  each time the container restarts. The schedule persists in Redis under
  the deterministic key and is overwritten cleanly.

## Failure handling

The retention Worker's `failed` listener logs to stderr — this surfaces
in the docker-compose `worker` service logs (`docker compose logs
worker`). If the operator sees `[retention] job … failed: …` on three
consecutive nights, that's a signal something else is wrong (DB
down, lock contention, Redis amnesia). BullMQ's default retry policy
applies — the failed job is retried with exponential backoff up to the
default attempt count. We do not surface failures to the inbox API or
the audit log: the cost of a missed nightly purge is bounded (one extra
day's notifications) and we'd rather not noise up the audit feed with
infrastructure events.

## Non-goals

- No new env var. The cron expression is hard-coded — operators who
  want a different schedule can change `'0 3 * * *'` in one place.
  An env-var-driven cron would be premature configuration.
- No retention policy for audit_log, video_submissions, or any other
  table. SM-8 only mentions notifications. Other tables have their own
  retention discussions (audit log retention is in the GDPR-adjacent
  compliance backlog, not here).
- No backfill. The script deletes everything older than 90 days on its
  first run — that's the desired behaviour, not a migration concern.
- No metrics export to Prometheus / posthog. The `[retention]`
  prefix in stdout is enough operator visibility for v1.

## Definition of done

- `apps/worker/src/index.ts` defines `new Queue('retention', ...)` and
  `new Worker('retention', ...)` and calls
  `retentionQueue.add('deleteOldNotifications', {}, { repeat: { cron:
  '0 3 * * *' }, jobId: 'retention:nightly' })` on boot.
- `packages/db/src/scripts/retention.ts` exports a
  `deleteOldNotifications()` function that returns the delete row
  count; the CLI entry point is preserved behind an
  `import.meta.url === pathToFileURL(process.argv[1]).href` guard.
- `packages/db/src/index.ts` re-exports `deleteOldNotifications`.
- Spec-025 governance test still passes (we kept `RETAIN_DAYS = 90`,
  `db.delete(notifications)`, and `lt(notifications.createdAt, …)`
  in retention.ts).
- New governance test
  `tests/governance/test_107_sm8_retention_cron.test.mjs` asserts the
  queue/worker/cron/jobId/import/export contract (≥ 6 assertions).
