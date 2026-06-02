# Spec 162 — Transcode DLQ admin view (Workflow Run 15 audit closure, MISS)

## Why

Workflow Run 15's audit closure flagged a missing operator surface
under "MISS: failed transcode jobs end up in BullMQ DLQ. No admin UI
to inspect or retry." Pre-spec, when a transcode job exhausts its
three BullMQ attempts (5s / 10s / 20s exponential backoff from spec
151) it lands as `status='failed'` in the `transcode_jobs` table AND
as a failed entry in the BullMQ DLQ — and no human-facing surface
shows it. Operators learned about failed jobs by:

1. The topbar queue indicator (`loadQueueDepth`, spec 128) which
   shows aggregate `failed` count but never the per-row detail.
2. A mentor reporting "my upload still says queued" in WhatsApp.
3. Greping the postgres logs for `transcode_jobs WHERE status='failed'`.

All three are reactive. The DLQ should be a first-class admin view
(the same way `/admin/whatsapp-log` in spec 126 lifted the WhatsApp
ingest log into operator vision) with two operator verbs:

- **Retry.** Re-enqueue the failed job onto `transcodeQueue` with
  the same payload the webhook / direct-upload uses, so the worker
  picks it up identically.
- **Drop.** Mark the job as permanently buried — no re-enqueue, the
  parent `video_submission` flips to `failed` so the videos library
  tells the truth.

The verb pair mirrors the production-grade DLQ patterns (BullMQ's
own Bull Board UI uses "retry" / "discard"; Sidekiq uses "retry" /
"delete"). We add a NEW `dropped` status to `transcode_jobs.status`
(distinct from `cancelled`, which is reserved for the worker's own
abort path) so the audit story is unambiguous.

## What we ship

### `packages/db/src/schema/videos.ts` (EDITED)

- The `transcode_jobs_status_check` CHECK constraint is widened to
  include `'dropped'` alongside the existing five statuses. An
  inline comment explains the operator-verb semantics.

### `packages/db/src/migrations/0021_transcode_jobs_dropped_status.sql` (CREATED)

- DROP + ADD the CHECK constraint to widen the status set in the
  live DB. Single-transaction; no data migration (existing rows
  carry one of the five legacy statuses, all valid under the new
  CHECK). Migration index 0021 is the workflow-coordinated slot
  (0019 reserved for spec 159, 0020 for spec 161).

### `apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx` (CREATED)

- Server component, `force-dynamic`, role gate
  `programme_admin + super_admin` via `requireRole`. Audits the
  surface view itself (`transcode.dlq.surface_viewed`).
- Top strip: BullMQ live queue depth via
  `transcodeQueue.getJobCounts("waiting","active","failed","delayed")`.
  Reads gracefully through a try/catch so Redis-down renders a
  "depth unavailable" hint without breaking the table view.
- Filter pills (URL-driven, `<Link>` anchors): **All / Failed /
  In progress / Queued / Recent (24h)**.
- Table: status chip, video deep-link (`/videos/<id>`), source chip
  (`whatsapp`/`direct`/`external_link`/`google_drive`), error
  excerpt (truncated to 60 chars, full text on hover), attempts
  count, last-updated timestamp, action column.
- Sort order: failed first, then running → queued → succeeded →
  cancelled → dropped (so DLQ-relevant rows surface immediately).
- Action column: `Retry` (failed-only) and `Drop` (failed-only)
  buttons wired as `<form action={…ServerAction}>`. Non-failed
  rows show "—".

### `apps/web/src/app/(authenticated)/admin/transcode-jobs/actions.ts` (CREATED)

- `"use server"` directive.
- `retryTranscodeJobAction(formData)`:
  - `requireRole(["programme_admin","super_admin"])`.
  - Reads the `jobId` from formData, joins
    transcode_jobs ⨝ video_submissions ⨝ files for the bucket +
    object key.
  - Rejects non-`failed` rows with `error=not_retriable_status`.
  - Flips the parent submission back to `queued`.
  - Calls `transcodeQueue.add("transcode", {videoSubmissionId,
    fileId, bucket, objectKey, source})` — same payload shape as
    `api/webhooks/whatsapp/route.ts`.
  - Records `transcode.retry_requested` with previousStatus +
    submission id + bucket + object key.
  - `revalidatePath` + `redirect` back to `/admin/transcode-jobs`.
- `dropTranscodeJobAction(formData)`:
  - Same role gate. Same `jobId` extraction.
  - Rejects non-`failed` rows with `error=not_droppable_status`.
  - `db.update(transcodeJobs).set({ status: "dropped", endedAt: now })`.
  - Flips the parent submission to `failed` so the videos library
    surfaces a stable terminal state.
  - Records `transcode.dropped` with previousStatus + submission id +
    bullJobId.
  - `revalidatePath` + `redirect`.

### `apps/web/src/app/(authenticated)/admin/page.tsx` (EDITED)

- New entry in the System section linking to `/admin/transcode-jobs`.
  Mirrors the layout pattern used by /admin/whatsapp-log, gates
  (no separate gate; the destination guards itself).

## Acceptance criteria

- `transcode_jobs.status` accepts `'dropped'` at the DB level
  (migration 0021 widens the CHECK).
- `/admin/transcode-jobs` renders as a server component with
  `requireRole(["programme_admin","super_admin"])`.
- The page calls `transcodeQueue.getJobCounts` and surfaces the four
  state counts in a top strip.
- Filter pills cover the five filter keys; the URL drives the filter.
- The table joins `transcode_jobs` to `video_submissions` and shows
  status, video link, source, error excerpt, attempts, updated.
- Failed rows render a Retry and a Drop button; non-failed rows do
  not.
- `retryTranscodeJobAction` calls `transcodeQueue.add` with the
  five-field payload and records `transcode.retry_requested`.
- `dropTranscodeJobAction` marks the row `dropped` and records
  `transcode.dropped`.
- The admin index has a link to `/admin/transcode-jobs`.
- `tests/governance/test_162_transcode_dlq_admin_view.test.mjs`
  passes with ≥ 8 assertions covering the above.

## Non-goals

- **No Bull Board UI replacement.** The admin surface lists DB rows;
  Bull Board (or any third-party BullMQ UI) is out of scope. A future
  spec can choose to mount Bull Board at `/admin/bull-board` if
  programme staff need raw Redis introspection.
- **No bulk operations.** Per-row Retry / Drop is enough at current
  scale (~tens of failures per quarter). Bulk "retry all failed in
  the last 24h" can be a follow-up spec when the operator volume
  warrants it.
- **No automatic retry escalation.** BullMQ's three-attempt policy
  (spec 151) is the automated path; this surface is for the human
  decision after that policy gives up.
- **No DLQ entry deletion from Redis.** The `removeOnFail age:7d`
  policy in `apps/worker/src/queues.ts` already ages out DLQ
  entries; the admin surface relies on the DB row, not the Redis
  entry, as the source of truth.
