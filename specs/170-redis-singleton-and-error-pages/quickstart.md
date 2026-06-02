# Quickstart 170 — Redis singleton and error-page variants

Two manual smoke checks. Total time under five minutes.

## (A) Redis singleton

1. Start the LMS stack:
   ```
   docker compose up -d
   ```
2. Confirm exactly ONE web-side direct-redis connection by counting
   `CLIENT LIST` entries from outside the BullMQ subscriber set:
   ```
   docker compose exec redis redis-cli CLIENT LIST | grep -v "name=bullmq"
   ```
   Expected: one entry per running web process (1 in dev). Pre-fix
   each Next.js process held TWO — one for rate-limit, one for
   /api/health probes — so the count was double.
3. Curl the health endpoint to exercise the ping path:
   ```
   curl -s http://localhost:3000/api/health | jq '.checks.redis'
   ```
   Expected: `{"ok":true}`. The redis check went through the
   singleton's `pingRedis()` rather than constructing its own
   one-shot connection.
4. Trigger a rate-limited endpoint twice in quick succession to
   exercise the ZADD path:
   ```
   for i in {1..6}; do
     curl -s -X POST http://localhost:3000/api/auth/forgot-password \
       -H 'content-type: application/json' \
       -d '{"email":"none@example.com"}'
   done
   ```
   Expected: first 3 return 200, the next 3 return 429 (the
   spec-161 3/hr per-IP rate limit). The 4th, 5th, 6th calls went
   through `getRedis()` in `rate-limit.ts`, not a fresh
   `new Redis(...)` per call.
5. Stop redis and re-trigger to confirm fail-closed contract:
   ```
   docker compose stop redis
   curl -s -X POST http://localhost:3000/api/auth/forgot-password \
     -H 'content-type: application/json' \
     -d '{"email":"none@example.com"}'
   ```
   Expected: 503 (rate-limit fail-closed throws → handler catches
   → returns 503). The singleton's throw is the throw that fires;
   the caller's try/catch is unchanged from spec 141.
6. Restart redis and confirm normal behaviour resumes:
   ```
   docker compose start redis
   ```

## (B) Forbidden page variants

7. Visit each variant URL directly. The page is a Server Component
   so a logged-out visit works for snapshotting copy:
   ```
   curl -s "http://localhost:3000/forbidden" | grep -o 'data-reason="[^"]*"'
   curl -s "http://localhost:3000/forbidden?reason=locked"
   curl -s "http://localhost:3000/forbidden?reason=smtp_unconfigured"
   curl -s "http://localhost:3000/forbidden?reason=session_expired"
   curl -s "http://localhost:3000/forbidden?reason=foobar"
   ```
   Expected:
   - default → `data-reason="default"`, copy "You don't have
     permission to view this page."
   - locked → "Your account is temporarily locked due to too many
     failed login attempts. Try again in 1 hour or contact your
     administrator." (the "1 hour" fallback fires when no
     session is present to read locked_until from).
   - smtp_unconfigured → "Email-based actions (magic-link sign-in,
     password reset) are not available on this deployment. Use
     credential sign-in or contact your administrator."
   - session_expired → "Your session has ended. Please sign in
     again."
   - foobar (unknown reason) → falls through to default copy.

8. Exercise the locked-via-login path. Pick a teacher account
   ("teacher.demo@gml.org" from the seed), POST 5 wrong passwords
   in quick succession:
   ```
   for i in {1..5}; do
     curl -s -X POST http://localhost:3000/api/auth/callback/credentials \
       -d "email=teacher.demo@gml.org&password=wrong-$i" \
       -H 'content-type: application/x-www-form-urlencoded'
   done
   ```
   The 5th call arms the lockout. Now try a 6th with the right
   password:
   ```
   curl -s -i -X POST http://localhost:3000/api/auth/callback/credentials \
     -d 'email=teacher.demo@gml.org&password=correct-horse-battery-staple' \
     -H 'content-type: application/x-www-form-urlencoded'
   ```
   Expected: 302 redirect to `/forbidden?reason=locked` (the auth.ts
   `throw new AccountLockedError()` path → loginAction catches →
   redirect with the locked reason). Visiting that URL shows the
   "try again in 60 minutes" copy.

9. As super_admin, clear the lockout to restore normal flow:
   ```
   curl -s -X POST -b "$ADMIN_COOKIES" \
     "http://localhost:3000/api/admin/users/$USER_ID/unlock"
   ```

## Test gate

10. Run the scoped governance suite:
    ```
    pnpm test -- --test-name-pattern "spec 170"
    ```
    All assertions green.

11. Run the full suite — no regression from the singleton refactor:
    ```
    pnpm test
    ```
    All 1423 pre-spec tests still pass plus the new spec 170
    assertions.
