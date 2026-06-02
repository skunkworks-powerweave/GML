# Quickstart 144 — WhatsApp idempotency + media-proxy Range

Manual smoke (8 minutes). Requires the local stack running with
docker-compose (postgres + redis + minio) + the worker + the web app.

## Issue 1 — WhatsApp idempotency

1. Run the migration: `pnpm --filter @gml/db migrate`. Verify the
   column is in place:

   ```
   docker exec -it gml-postgres psql -U gml -d gml -c \
     "SELECT column_name FROM information_schema.columns
      WHERE table_name='video_submissions'
        AND column_name='whatsapp_message_id';"
   ```

   Expected: one row, `whatsapp_message_id`.

2. Verify the partial unique index:

   ```
   docker exec -it gml-postgres psql -U gml -d gml -c \
     "SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename='video_submissions'
        AND indexname='video_submissions_whatsapp_message_id_uq';"
   ```

   Expected: one row, indexdef contains `WHERE (whatsapp_message_id
   IS NOT NULL)`.

3. Fire the webhook twice with the same `messages[].id`:

   ```
   SIG=$(WEBHOOK_PAYLOAD=$(cat tests/fixtures/whatsapp-msg.json) \
         node -e "console.log('sha256=' + require('crypto')
         .createHmac('sha256', process.env.WHATSAPP_APP_SECRET || 'dev')
         .update(require('fs').readFileSync(0))
         .digest('hex'))" < tests/fixtures/whatsapp-msg.json)
   curl -X POST http://localhost:3000/api/webhooks/whatsapp \
     -H "Content-Type: application/json" \
     -H "x-hub-signature-256: $SIG" \
     --data-binary @tests/fixtures/whatsapp-msg.json
   # Repeat the same curl 2 more times.
   ```

   Both repeated calls return `{"ok": true}` with status 200.

4. Confirm the dedup happened end-to-end:

   ```
   docker exec -it gml-postgres psql -U gml -d gml -c \
     "SELECT COUNT(*) FROM video_submissions
      WHERE whatsapp_message_id='wamid.test-replay-001';"
   ```

   Expected: `1`, not 3.

5. Confirm the replay was audited:

   ```
   docker exec -it gml-postgres psql -U gml -d gml -c \
     "SELECT COUNT(*) FROM audit_log
      WHERE action='whatsapp.message.replay_ignored'
        AND (metadata->>'msgId')='wamid.test-replay-001';"
   ```

   Expected: `2` (one per replay; the original is audited as
   `whatsapp.message.received`).

6. Confirm the BullMQ queue only enqueued one transcode:

   ```
   docker exec -it gml-redis redis-cli \
     "ZRANGE bull:transcode:wait 0 -1" | grep test-replay-001 | wc -l
   ```

   Expected: ≤ 1 (the worker may have already processed and removed
   it; the point is it's not 3).

## Issue 2 — Media-proxy Range header

7. Mint a signed URL for any existing HLS segment (you can grab one
   from `/admin/data/files` or the worker's audit log):

   ```
   TOKEN=...  # paste a fresh signed token from the UI
   ```

8. Issue a full-body GET (no Range) and verify 200 + Accept-Ranges
   advertisement:

   ```
   curl -i http://localhost:3000/api/media/$TOKEN | head -10
   ```

   Expected response headers:
   - `HTTP/1.1 200 OK`
   - `Accept-Ranges: bytes`
   - `Content-Type: video/MP2T` (segment) or `application/vnd.apple.mpegurl` (master)

9. Issue a partial GET with Range and verify 206 + Content-Range:

   ```
   curl -i -H "Range: bytes=0-1023" \
     http://localhost:3000/api/media/$TOKEN | head -10
   ```

   Expected response headers:
   - `HTTP/1.1 206 Partial Content`
   - `Accept-Ranges: bytes`
   - `Content-Range: bytes 0-1023/<full-size>`
   - `Content-Length: 1024`

10. Issue an open-ended Range and verify it works:

    ```
    curl -i -H "Range: bytes=1024-" \
      http://localhost:3000/api/media/$TOKEN | head -10
    ```

    Expected: `206 Partial Content` with `Content-Range:
    bytes 1024-<end>/<full-size>`.

11. Browser-side check: open `/videos/<id>` in Chrome with the
    Network tab open, click a known timestamp deep into the video,
    and verify HLS.js's segment GET shows up as `206 Partial Content`
    instead of `200 OK`. The seek should complete in under ~500 ms
    on local; pre-fix it took ~3 s because the entire segment
    re-downloaded.

## Test gate

12. Run the scoped governance suite:

    ```
    pnpm test -- --test-name-pattern "spec 144"
    ```

    Expected: all assertions green.

13. Full suite stays green (this spec is purely additive for the
    happy path: existing tests that don't send Range still get 200,
    and existing webhook payloads that don't include a duplicate
    msg.id still insert exactly one row).
