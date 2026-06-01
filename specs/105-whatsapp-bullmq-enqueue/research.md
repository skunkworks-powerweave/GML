# Research 105

## D-001 — Import the Queue from @gml/worker rather than constructing one in apps/web

`apps/worker/src/index.ts` already constructs `transcodeQueue` with the
BullMQ producer-side connection options (`maxRetriesPerRequest: null`,
`enableReadyCheck: false`) and the queue-name literal `"transcode"`. We
re-export it so the web app's enqueue path uses exactly the same
configuration the worker reads from — no risk of name drift, no
duplicated `IORedis` setup.

## D-002 — Use `.returning({ id })` to feed the BullMQ payload

The BullMQ job needs `videoSubmissionId` so the worker can flip the row
to `status='ready'` after HLS packaging. We capture the new id via
Drizzle's `.returning({ id: videoSubmissions.id })` rather than a
separate SELECT — one fewer round-trip on the hot path.
