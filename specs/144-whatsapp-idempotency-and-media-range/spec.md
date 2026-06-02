# Spec 144 — WhatsApp idempotency + media-proxy Range header (Workflow Run 13 audit-closure CRITICAL+HIGH)

## Why

Two HIGH-severity findings from the 7-agent code audit, both in the
video pipeline, both reachable in production today.

### Issue 1 — WhatsApp webhook is not idempotent

Meta's WhatsApp Business Cloud API uses an at-least-once delivery
guarantee. If our `POST /api/webhooks/whatsapp` response isn't a 2xx
within roughly 20 seconds (slow ffmpeg enqueue under load, momentary
DB stall, a worker thread blocked on cold-start), Meta retries the
same payload — same `messages[].id` — two more times within a few
minutes. The audit traced the path in
`apps/web/src/app/api/webhooks/whatsapp/route.ts`: every retry runs
through the same flow end-to-end, inserting a fresh `files` row,
a fresh `video_submissions` row, and enqueuing a fresh BullMQ
transcode job. Three identical 480p HLS bundles in MinIO. Three rows
on the `/videos` listing. Triple ffmpeg CPU burn on the worker.

In the field this matters most when the network is slow. A teacher
in Ladakh on a 2G cell sends one video and Meta's retry policy kicks
in three times because our roundtrip is slow. The teacher sees three
copies of the same video, our worker burns through three transcode
jobs, and `/admin/data/videos` shows three rows that ops then have
to manually deduplicate.

### Issue 2 — Media proxy ignores Range requests

`apps/web/src/app/api/media/[token]/route.ts` always returns 200 +
full body. HLS.js, the player on `/videos/[id]` (spec 042 / 132),
sends `Range: bytes=<start>-<end>` for every segment fetch — that's
how the browser seeks without re-downloading from byte zero. Without
Range pass-through:

- Every seek (clicking on the scrubber, skipping to the end, even
  HLS.js's natural segment boundary fetches) re-downloads the entire
  segment from byte 0.
- On the low-bandwidth networks we explicitly target (Ladakh
  cellular, dropping in and out, SM-7 budget), this triples segment
  transfer cost.
- HLS.js falls back to a "buffer from start" loop that visibly stalls
  for ~3 seconds every seek; mentors reviewing teach-back videos in
  the field rated this the #1 video-player annoyance.

The fix is small (≈40 lines of route handler), surgical, and changes
no contract: callers that don't send Range still get the full
200-body path; callers that do get 206 + Content-Range, which is what
the browser already expects.

## What we ship

### 1. Schema column + migration 0017_whatsapp_dedup

`packages/db/src/schema/videos.ts` (EDITED): adds
`whatsappMessageId: text("whatsapp_message_id")` to `video_submissions`
plus a partial `uniqueIndex` keyed on that column with
`WHERE whatsapp_message_id IS NOT NULL`. Nullable so non-whatsapp
ingest paths (direct tusd upload, external URL embed) carry NULL and
are exempt from the unique constraint.

`packages/db/src/migrations/0017_whatsapp_dedup.sql` (CREATED):
two-statement migration — `ALTER TABLE … ADD COLUMN` then
`CREATE UNIQUE INDEX … WHERE whatsapp_message_id IS NOT NULL`.

`packages/db/src/migrations/meta/_journal.json` (EDITED): adds the
0017 entry.

`packages/db/src/migrations/meta/0017_snapshot.json` (CREATED):
cumulative snapshot post-0017 — same as 0015 with the new column +
partial unique index baked into `public.video_submissions`.

### 2. `apps/web/src/app/api/webhooks/whatsapp/route.ts` (EDITED)

Two changes to `ingestVideoMessage()`:

1. Pre-check at the top: `SELECT id FROM video_submissions WHERE
   whatsapp_message_id = msg.id LIMIT 1`. If a row exists, audit
   `whatsapp.message.replay_ignored` (with entityId = existing row
   id) and return — we tell Meta `{ ok: true }` so it stops retrying.
2. `.values({…})` carries `whatsappMessageId: msg.id` and the insert
   is wrapped in `.onConflictDoNothing({ target: …, where: isNotNull(…) })`
   so the DB-level partial UNIQUE INDEX is the final arbiter. If the
   conflict wins (race between two concurrent Meta retries that both
   passed the pre-check), `.returning()` returns `[]`, we audit
   `whatsapp.message.replay_ignored` with `reason: "insert_conflict"`,
   and short-circuit out — no second transcode is enqueued.

The DB index is the belt; the pre-check is the suspenders; the
race-safe `onConflictDoNothing` is the second pair of suspenders.

### 3. `apps/web/src/app/api/media/[token]/route.ts` (EDITED)

Branches on the incoming `Range` header:

- `range` present → `GetObjectCommand({ …, Range: range })`, return
  `new Response(stream, { status: 206, headers: { …,
  "Content-Range": r.ContentRange, "Content-Length": r.ContentLength,
  "Accept-Ranges": "bytes" } })`.
- `range` absent → the original full-body 200 path with an added
  `"Accept-Ranges": "bytes"` header so browsers / HLS.js know they
  can issue a Range request on the next round-trip.

The signed-token verification path (spec 145's `ipToBindKey` wrap)
is preserved exactly — we only insert the Range branch between the
verify call and the response.

## Acceptance criteria

- `packages/db/src/schema/videos.ts` defines `whatsappMessageId: text(...)`
  on the `videoSubmissions` table.
- The same file declares a `uniqueIndex("video_submissions_whatsapp_message_id_uq")`
  with a `WHERE whatsapp_message_id IS NOT NULL` predicate.
- `packages/db/src/migrations/0017_whatsapp_dedup.sql` exists and
  contains both `ALTER TABLE "video_submissions" ADD COLUMN
  "whatsapp_message_id" text` AND
  `CREATE UNIQUE INDEX "video_submissions_whatsapp_message_id_uq"
  ON "video_submissions" ... WHERE "whatsapp_message_id" IS NOT NULL`.
- The drizzle journal contains an entry tagged `0017_whatsapp_dedup`.
- `apps/web/src/app/api/webhooks/whatsapp/route.ts` performs a
  `SELECT … WHERE whatsappMessageId = msg.id` pre-check before
  fetching media and audits `whatsapp.message.replay_ignored` when
  the row already exists.
- The insert path sets `whatsappMessageId: msg.id` and uses
  `.onConflictDoNothing(...)` so a race between concurrent Meta
  retries doesn't insert two rows.
- `apps/web/src/app/api/media/[token]/route.ts` reads the incoming
  `Range` header, forwards it to `GetObjectCommand` as `Range: ...`,
  and returns `status: 206` with `Content-Range`, `Content-Length`,
  and `Accept-Ranges: bytes` headers.
- The no-Range branch still returns `status: 200` with the original
  full body plus an `Accept-Ranges: bytes` advertisement header.
- All five spec-kit files exist under
  `specs/144-whatsapp-idempotency-and-media-range/`.
- `tests/governance/test_144_whatsapp_idempotency_and_media_range.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No new dependencies.** No `range-parser`, no `s3-stream-range`,
  no rewrite of the MinIO helper. We pass the header string straight
  through; PostgreSQL handles the partial unique index natively.
- **No tracking table.** Idempotency is enforced by the column-level
  partial UNIQUE INDEX, not a separate `whatsapp_message_log` table.
  One column, one index, one audit action — the smallest possible
  surface area.
- **No background dedup sweep.** Existing duplicate rows (from before
  this migration) are not retroactively merged. A separate spec /
  ops runbook can address those if any exist.
- **No Range parsing logic in our code.** We trust S3 / MinIO to
  reject malformed Range headers with 416 — we just forward them
  and surface whatever response the SDK gives us.
- **No cache invalidation work.** `Cache-Control: private, max-age=60`
  is unchanged; the 60-second window matches the signed-URL TTL so
  there's no leak risk.
- **No retroactive backfill.** Rows from before this spec have
  `whatsapp_message_id` NULL and are exempt from the unique index;
  ops can backfill from `audit_log.metadata.msgId` later if needed.
