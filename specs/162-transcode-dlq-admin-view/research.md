# Research 162

Six design choices for the transcode DLQ admin surface.

## (1) New `dropped` status vs reusing `cancelled`

Two viable shapes for the operator-bury verb:

- **Reuse `cancelled`.** Lossy: the audit trail couldn't tell whether
  a job was killed by the worker (programmatic abort) or buried by an
  operator (manual decision) without joining `audit_log` and reading
  the action verb. Future retry queries (e.g. "find me every
  cancelled job and retry it") would have to join audit just to
  filter out operator-dropped rows. Tightly coupled.
- **Add `dropped` as a new terminal status.** Reads cleanly:
  `status='dropped'` means "operator looked, decided no retry". The
  worker's own `cancelled` path stays as-is. Retry queries can
  exclude `dropped` with a single column predicate.

We chose `dropped`. The widened CHECK constraint costs one
single-transaction migration and the schema gains a precise verb
where it had ambiguity. The pattern matches the videos enum (we
already have a half-dozen status enums where each value carries
exactly one semantic).

## (2) Sort order: status-keyed CASE expression vs separate queries

The DLQ-relevant rows (failed) need to surface immediately, but the
operator also needs to see queued + running + succeeded to sanity-check
"is the worker even processing right now?" Two approaches:

- **Three separate queries** — one for failed, one for in-flight, one
  for succeeded. Render them in three sections. Triples the round-trip
  cost; the rendering loses the unified "most recent activity"
  ordering.
- **One query with a CASE-keyed ORDER BY.** Single round-trip. The
  CASE expression pins the row to a sort bucket (failed=0, running=1,
  queued=2, succeeded=3, cancelled=4, dropped=5) and the secondary
  sort is `createdAt DESC` so within each bucket the newest row
  surfaces first.

We chose the single CASE query. PostgreSQL's planner handles the CASE
in the ORDER BY clause natively (no extra sort cost over a plain
order). The result reads like a Kanban "by-priority" view rather
than three flat lists.

## (3) Re-enqueue payload identity with the webhook path

The worker's transcode pipeline expects a five-field payload:
`{ videoSubmissionId, fileId, bucket, objectKey, source }`. The
WhatsApp webhook in `api/webhooks/whatsapp/route.ts` and the existing
`resendTranscodeAction` in `/admin/whatsapp-log/actions.ts` both
populate exactly this shape.

For Retry we MUST use the same shape so the worker takes its
source-specific branches correctly:
- `source: 'whatsapp'` → skip full ffmpeg re-encode (the WhatsApp
  branch in `transcode.ts` does a faster HLS-only repackage).
- `source: 'direct'` or `'external_link'` or `'google_drive'` → full
  ffmpeg encode.

The actions module joins `transcode_jobs ⨝ video_submissions ⨝ files`
in a single round-trip to recover all five fields. The `source` is
read from `video_submissions.source` (the source-of-truth — the
worker uses the parent submission's source, not the job's, because
a video submission's source is immutable).

## (4) Why a NEW transcode_jobs row on retry vs updating the existing one

Two patterns:

- **Update-in-place.** Flip the existing failed row back to
  `queued`, clear the error, watch the worker pick it up. Simpler
  state, but loses the attempt history — three retries leave three
  status flips on one row, no way to see "this was attempted four
  times" without re-reading the audit log.
- **Append a new row.** The worker INSERTs a fresh `transcode_jobs`
  row when it picks up the job (see `transcode.ts:33-41`). The
  failed row stays as part of the attempt history. The
  `attemptsBySubmission` count in the page surfaces "this submission
  has 4 transcode_jobs rows" without any extra query.

We use the append pattern because the worker already INSERTs on job
pickup — the action just enqueues, the worker handles the row
sequence. The retry button leaves the failed row alone; future
queries can read N rows of attempt history per submission directly.

## (5) BullMQ getJobCounts in a server component — connection cost

`getJobCounts` opens an ioredis connection. The producer connection
in `apps/worker/src/queues.ts` is `lazyConnect: true` so the first
call from a Next.js server route triggers the connect; subsequent
calls reuse the pool. The same pattern already powers
`loadQueueDepth` in `chrome-counts.ts` (spec 128) — every
authenticated page renders the topbar with a `getJobCounts` call,
and the production deployment runs fine.

The DLQ surface adds ONE additional `getJobCounts` per render
(scoped to the `/admin/transcode-jobs` route, only when an admin
actually loads it). Negligible. The try/catch ensures Redis-down
renders the DB table without breaking — better than throwing through
the server-render boundary.

## (6) Why URL-driven filter pills vs a client component with useState

The /admin/whatsapp-log page (spec 126) set the precedent: filter
controls are `<Link>` anchors that drive `searchParams`, the page is
a pure server component, no client component needed. The DLQ
surface follows the same pattern because:

- **Bookmarkability.** An operator can copy the URL with the Failed
  pill active and share it on Slack: "the DLQ here, look at the
  failed ones".
- **No client/server boundary churn.** The Retry / Drop verbs are
  `<form action={…serverAction}>` — both the read path (filter) and
  the write path (verbs) stay on the server.
- **Simpler reasoning about state.** The URL IS the state. No
  `useState` to keep in sync.

The pills render as 5 anchors with `aria-current="page"` on the
active one — accessible to screen readers and keyboard users
without any extra wiring.
