# Quickstart 141 — Auth fail-closed and gate audit

Manual smoke (8 minutes), needs `pnpm dev` + docker-compose
(postgres + redis + minio) running, a seeded `super_admin`
account, and one of the four gated sections (observation /
mentorship / tkt / ttt) configured with a known password.

## Gate audit emission (happy path)

1. Sign in as any mentor / programme_admin / super_admin.
2. Navigate to `/mentorship` (or any path under a gate prefix —
   `/observation`, `/rtt/tkt`, `/rtt/ttt` all work). The
   middleware redirects you to `/gate/<slug>?next=...`.
3. Type the correct gate password and submit. You are redirected
   to the `next` destination as before.
4. Open a fresh `psql` window:
   ```sql
   SELECT action, entity_id, metadata, created_at
   FROM audit_log
   WHERE action LIKE 'gate.attempt.%'
   ORDER BY created_at DESC LIMIT 3;
   ```
   You should see one `gate.attempt.success` row with
   `entity_id = '<slug>'` and metadata
   `{ "slug": "<slug>", "attemptCount": 1, "rateLimited": false }`.

## Gate audit emission (wrong password)

5. Hit `/gate/mentorship?next=/mentorship` again, this time type
   a wrong password.
6. The page re-renders with "Wrong password.". Re-run the SQL
   query — there is now a `gate.attempt.fail` row with metadata
   `{ "slug": "mentorship", "attemptCount": 2, "rateLimited": false,
   "reason": "wrong_password" }`. (`attemptCount` ticks up on
   every attempt that the rate-limit actually evaluated.)

## Rate-limit ceiling audit

7. Repeat step 5 four more times (total 5 failures in the same
   15-minute window). The 6th attempt returns "Too many attempts.
   Try again in N minutes." instead of "Wrong password.".
8. Re-run the SQL query — the 6th row is also
   `gate.attempt.fail` but with metadata
   `{ "slug": "mentorship", "rateLimited": true, "reason":
   "rate_limit_exceeded" }`. This is the brute-force fingerprint
   the `/admin/gates` dashboard surfaces.

## Redis fail-closed (the headline behaviour change)

9. Stop the Redis container:
   `docker-compose stop redis`.
10. Hit `/gate/observation?next=/observation` with any password.
    Previously this would have allowed unlimited guessing. Now
    you see "Service temporarily unavailable." and the action
    short-circuits before the bcrypt compare runs.
11. Re-run the SQL query (and add the redis_down action):
    ```sql
    SELECT action, entity_id, metadata, created_at
    FROM audit_log
    WHERE action IN ('gate.rate_limit.redis_down',
                     'auth.rate_limit.redis_down')
    ORDER BY created_at DESC LIMIT 3;
    ```
    You should see one `gate.rate_limit.redis_down` row with
    metadata `{ "slug": "observation", "severity": "SEVERE",
    "error": "..." }`. The error string is truncated to 200 chars
    so a chatty stack trace can't blow up the JSONB column.

## Login fail-closed (with Redis still stopped)

12. Sign out. Navigate to `/login`. Type a valid email +
    password. Previously this would log you in (silent
    fail-open). Now the credentials provider returns `null` and
    the page re-renders with the generic Auth.js credential
    failure copy ("Sign in failed.").
13. The SQL query now shows an `auth.rate_limit.redis_down` row
    with metadata `{ "method": "credentials", "ipMasked":
    "<masked>", "severity": "SEVERE", "error": "..." }`. The
    `ipMasked` value drops the last IPv4 octet so `127.0.0.1`
    appears as `127.0.0.xxx`.

## Recovery

14. Restart Redis: `docker-compose start redis`. Within ~5s the
    next login + gate attempt succeed on the happy path; no
    further `*.rate_limit.redis_down` rows appear unless Redis
    flaps again.

## /admin/gates dashboard sanity check

15. Sign in as a super_admin and navigate to `/admin/gates`. The
    `Attempts (30d)` and `Failures (30d)` columns now reflect the
    real audit rows from steps 1-8. Previously these columns
    showed `0` regardless of activity.
