# Quickstart 154 — API hardening

Four short manual checks. All assume `pnpm dev` plus the docker-compose
db / redis / minio stack running locally.

## (A) tus auth gate (Issue 1)

1. Boot `pnpm dev` with `TUSD_INTERNAL_URL` UNSET in `.env.local`
   (this exercises the 501 branch too).
2. Open a terminal and probe each method without a session cookie:
   ```sh
   curl -i -X POST http://localhost:3000/api/uploads/tus
   curl -i -X PATCH http://localhost:3000/api/uploads/tus
   curl -i -X HEAD  http://localhost:3000/api/uploads/tus
   curl -i -X DELETE http://localhost:3000/api/uploads/tus
   curl -i -X GET    http://localhost:3000/api/uploads/tus
   ```
   Each should return `401` with body
   `{"error":"unauthorized"}` (HEAD returns the same status with an
   empty body).
3. Now log in as a mentor (any seeded account) and re-run the same
   curl with the session cookie. POST should return `501` with body
   `{"error":"tusd_unavailable"}` — and CRUCIALLY no
   `TUSD_INTERNAL_URL` or `http://tusd:1080` text anywhere in the
   response.
4. Check the `pnpm dev` console — you should see a
   `[uploads/tus] tusd unavailable` warn line. That's the
   diagnostic ops will see.

## (B) tus 501 information disclosure (Issue 2)

5. Confirm step 3 above: the response body is exactly
   `{"error":"tusd_unavailable"}`. The previous shape was
   `{"error":"tusd_not_configured","hint":"Set TUSD_INTERNAL_URL=..."}`
   — that hint is gone.
6. Now set `TUSD_INTERNAL_URL=http://tusd:1080` in `.env.local` and
   restart `pnpm dev` with the `tusd` container running (`docker
   compose up tusd`). The same POST with a session cookie now
   proxies through to tusd and returns the upstream's 201 with the
   `Location:` header. The auth gate fires before the proxy, so the
   curl without a cookie still 401s.

## (C) form-drafts invalid JSON (Issue 3)

7. As a logged-in mentor, find a template ID (any from the
   `templates` seed). Then POST a malformed body:
   ```sh
   curl -i -X PUT 'http://localhost:3000/api/form-drafts/<template-id>?scope=template' \
     -H 'Content-Type: application/json' \
     -b cookies.txt \
     -d '{"responses": {'   # truncated, syntax error
   ```
   Response: `400` with body
   `{"error":"invalid_json","message":"SyntaxError: ..."}`.
   The pre-fix shape returned `400 validation_failed` with empty
   issues — same status code, different (and less diagnosable)
   semantics.
8. Sanity: send a well-formed body that fails the schema (e.g.
   `{"wrong_key": 1}`). Response is still `400 validation_failed`
   with the Zod `issues` array. The schema-validation 400 is
   unchanged — only the parse-failure path has new shape.

## (D) helpdesk rate limit (Issue 4)

9. As a logged-in mentor, POST to `/api/helpdesk/tickets` six times
   in rapid succession (a small bash loop with a 100ms sleep is
   enough). The first 5 return `200 { ok:true, delivered:<n> }`;
   the 6th returns `429` with body
   `{"error":"rate_limited","retryAfterMs":<ms>}` and a
   `Retry-After: <seconds>` header.
10. Check the audit log via `SELECT * FROM audit_logs WHERE action
   = 'helpdesk.ticket_rate_limited' ORDER BY created_at DESC LIMIT
   3`. A row is present for the throttled call.
11. Redis-down regression: `docker compose stop redis` and try the
    sixth call again. The handler logs `[helpdesk] rate-limit
    redis error — failing open` and the call SUCCEEDS (fail open
    semantics). Restart redis with `docker compose start redis`
    and the throttle resumes normal operation.

## Test gate

12. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 154"
    ```
    All assertions green. The previous 1197/1197 baseline still
    holds — this spec only adds new tests; the route-handler edits
    are additive in the auth/throttle paths and surgical in the
    JSON-parse path (no test reaches into the swallowed-error
    branch).
