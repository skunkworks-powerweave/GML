# Spec 105 — WhatsApp Webhook → BullMQ Transcode Enqueue (Workflow Run 7 Tier C1)

## Why

The WhatsApp webhook is the *primary* upload path for teacher videos in the
RTT programme — observations, teach-backs, and mentor-meeting recordings
all arrive as a WhatsApp video with a coded caption. Until this spec, the
webhook persisted the original bytes to MinIO and inserted a
`video_submissions` row with `status='received'`, then stopped. The row
sat in `received` indefinitely because the BullMQ enqueue call had been
deferred to "when the worker ships" — but the worker has now shipped
(spec 036/037 + spec 100 swapped the container CMD to the real worker
entrypoint), so the deferral is no longer a deferral, it's a missing
edge. Teachers' videos appeared in `/admin/data/videos` but never moved
to `ready`, so the mentor's drill-in screen showed "video uploading…"
forever. The deployment audit (Workflow Run 7) flagged this as a Tier C
operational gap that blocks the very first WhatsApp dogfood test.

## What

Wire the WhatsApp webhook (`apps/web/src/app/api/webhooks/whatsapp/route.ts`)
to the BullMQ `transcode` queue exported by `apps/worker/src/index.ts`.
Specifically:

1. Add `@gml/worker` to `apps/web/package.json` as a workspace dep, and
   add an `exports` block to `apps/worker/package.json` so the import
   resolves to `./src/index.ts` (matching `@gml/db` and `@gml/shared`).
2. Import `transcodeQueue` at the top of the webhook route.
3. After the `video_submissions` INSERT, capture the new row's `id` via
   `.returning({ id })` and call `transcodeQueue.add("transcode", {
   videoSubmissionId, fileId, bucket, objectKey, source: "whatsapp" })`.
   The payload shape matches `TranscodeJobInput` exported by the worker
   module — `source: "whatsapp"` is the documented "skip re-encode but
   still HLS-package" variant.
4. Audit `transcode.enqueued` (entityType `video_submission`, entityId =
   the new submission id, metadata includes `source: "whatsapp"`, the
   msg id for cross-referencing the incoming webhook log line, and the
   bucket + objectKey so an ops engineer can find the original blob in
   MinIO if the transcode fails).
5. Remove the obsolete deferred-stub comment ("Implementation lands when
   BullMQ + ffmpeg worker ship") — leaving it would confuse a future
   reader who tried to re-enqueue thinking it was still a stub.

## Why not just import bullmq in the route directly

The worker already constructs the `Queue` with the right Redis connection
options (`maxRetriesPerRequest: null`, `enableReadyCheck: false`) which
match BullMQ's required producer-side configuration. Re-constructing the
Queue in `apps/web` would (a) duplicate connection config that can drift,
(b) require apps/web to take a direct dependency on `ioredis` for the
Queue constructor's connection arg (it already has it, but the coupling
would be implicit), and (c) split the queue-name string literal across
two packages. Exporting the Queue from `@gml/worker` and importing it
keeps a single source of truth for queue name + connection options.

## Non-goals

- No retry policy tweaks. Default BullMQ retries (3 attempts, exponential
  backoff) are correct for this stage.
- No dedup. Meta sends webhook deliveries at-least-once, so a duplicate
  caption could theoretically produce two submissions; that's covered by
  spec 042's idempotency-by-checksum work, not this spec.
- No fan-out to multiple queues. There is exactly one queue (`transcode`)
  and the worker handles all `source` variants.

## Definition of done

- The webhook route imports `transcodeQueue` from `@gml/worker`.
- After the `video_submissions` insert, `transcodeQueue.add(...)` is
  awaited with `source: "whatsapp"`.
- An audit row `transcode.enqueued` is recorded with the submission id.
- The deferred-stub comment block is removed.
- Governance test `test_105_whatsapp_bullmq_enqueue.test.mjs` passes.
