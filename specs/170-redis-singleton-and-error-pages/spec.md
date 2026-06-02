# Spec 170 — Redis singleton and error-page variants (Workflow Run 16 post-audit hardening)

## Why

The post-Run-15 audit sweep flagged two related infrastructure rough
edges that don't break behaviour but do bloat the failure-mode surface
area:

1. **Multiple direct-redis clients in the web process.** Two distinct
   `new Redis(url, ...)` constructions live in `apps/web/src/lib`:
     - `rate-limit.ts` — the spec 141 fail-closed ZADD pipeline.
     - `health.ts` — the `/api/health` PING probe.

   Each call site picked its own defaults (`connectTimeout`,
   `maxRetriesPerRequest`, `lazyConnect`), opened a separate TCP
   connection, and made the connection lifecycle harder to reason
   about. A future contributor adding a third direct-redis caller
   (cron job, slow-cache layer, presence channel) would copy-paste one
   of the existing shapes and end up with a third connection — none of
   them consolidated.

   The fix is a singleton `getRedis()` factory in
   `apps/web/src/lib/redis.ts`. Defaults match the worker's
   `queues.ts` shape (`maxRetriesPerRequest: null`,
   `enableReadyCheck: false`, `lazyConnect: true`) so the web and
   worker processes have aligned semantics. Both pre-existing call
   sites are refactored to use it.

   **Scope clarification:** BullMQ producer connections in
   `apps/worker/src/queues.ts` are NOT routed through the singleton —
   BullMQ's contract is that the connection it owns is private to the
   Queue/Worker. The singleton is for DIRECT redis calls (ping,
   ZADD/ZCARD, SET/GET), not for BullMQ. Web-side
   `transcodeQueue.add` / `transcodeQueue.getJobCounts` callers
   inherit the worker package's bundled connection by importing the
   queue module — unchanged.

2. **`/forbidden` renders one generic copy for every failure cause.**
   Before this spec the page showed
   > "Your role does not permit access to this section. Contact your
   > programme administrator."
   regardless of WHY the user landed there. Three identifiable
   failure causes warranted distinct copy:

   - **`?reason=locked`** — the spec 161 lockout state machine fired
     because of 5 consecutive failed login attempts. The user needs
     a "try again in <N> minutes" message, not a "role doesn't
     permit" message.
   - **`?reason=smtp_unconfigured`** — the deployment has `SMTP_HOST`
     unset. Magic-link sign-in and forgot-password emails won't
     deliver. The user needs to be steered back to credential
     sign-in.
   - **`?reason=session_expired`** — the JWT aged out (8h `maxAge`
     per `auth.ts`). The user needs a sign-in prompt, not a 403.
   - **Default (no reason / unknown)** — the original role-gate copy
     stands. This is the spec-150 contract: middleware rewrites here
     with status 403 when an authenticated user lacks the role.

   `auth.ts` is wired to throw a distinguishable error
   (`AccountLockedError extends CredentialsSignin` with
   `code = "account_locked"`) on the lockout path. The
   `loginAction` server action catches that distinct code and
   redirects to `/forbidden?reason=locked` rather than re-rendering
   the login page with a generic "wrong password" string. The
   middleware's role-gate path is unchanged (still rewrites to
   `/forbidden` with no reason → default copy).

## What we ship

### `apps/web/src/lib/redis.ts` (CREATED)

A 50-line singleton:

```ts
let _client: IORedis | null = null;
export function getRedis(): IORedis { ... }
export async function pingRedis(): Promise<{ ok, error? }> { ... }
```

- `getRedis()` constructs on first call, caches in module scope.
- Defaults align with the worker's queues.ts shape.
- `pingRedis()` is a safe-never-throws liveness probe — the
  `/api/health` endpoint's redis check goes through it.

### `apps/web/src/lib/rate-limit.ts` (EDITED)

The local `client()` factory + `_client` variable is removed; calls
to `client()` route through `getRedis()` instead. The JSDoc
fail-closed block is updated to reference `getRedis()` rather than
the old `REDIS_URL not set` literal (the singleton defaults to
`redis://redis:6379` so the no-env case becomes ECONNREFUSED at
first command — still fail-closed, just at a slightly different
throw point). Behaviour is otherwise identical.

### `apps/web/src/lib/health.ts` (EDITED)

`pingRedis()` is rewritten to delegate to the new
`pingRedis` export from `./redis`. The old `new Redis(url, ...)` +
`client.connect()` + `client.quit()` per-probe shape is removed —
the singleton handles the connection lifecycle.

### `apps/web/src/app/forbidden/page.tsx` (EDITED)

Server Component (was a static functional component). Reads
`searchParams.reason` and renders one of four copy variants per
the matrix above. For `reason=locked`, calls `auth()` to read
`session.user.locked_until` and formats a concrete "try again in
<N> minutes" hint; falls back to "1 hour" when the timestamp is
absent. Page carries `data-testid="forbidden-page"` and
`data-reason={reason}` so e2e tests can pin the rendered variant.

### `apps/web/src/auth.ts` (EDITED)

Adds `class AccountLockedError extends CredentialsSignin` with
`code = "account_locked"`. The locked-account branch in
`authorize()` now THROWS this instead of returning null. The audit
row `auth.account.locked_attempt` still fires before the throw so
SM-1 coverage is preserved. Bad-credentials and rate-limit-deny
paths continue to return null (the spec 141 fail-closed and
spec-141 generic-error-on-attacker contract).

### `apps/web/src/app/login/actions.ts` (EDITED)

The catch block in `loginAction` detects `code === "account_locked"`
on the thrown `AuthError` and `redirect()`s to
`/forbidden?reason=locked`. Other AuthError causes (bad creds,
rate-limit deny) collapse to the existing generic "Invalid email or
password" copy on the login page (preserved spec 141 contract — we
don't leak which of those caused the miss).

## Acceptance criteria

- `apps/web/src/lib/redis.ts` exists and exports `getRedis()` and
  `pingRedis()`. The singleton uses
  `{ maxRetriesPerRequest: null, enableReadyCheck: false,
  lazyConnect: true }` matching the worker's queues.ts defaults.
- `apps/web/src/lib/rate-limit.ts` no longer constructs its own
  `new Redis(...)` instance; the `rateLimit` function calls
  `getRedis()` from `./redis`.
- `apps/web/src/lib/health.ts`'s `pingRedis` delegates to
  `./redis`'s `pingRedis` (no per-probe `new Redis` construction).
- `apps/web/src/app/forbidden/page.tsx` reads `searchParams.reason`
  and renders distinct copy for `locked`, `smtp_unconfigured`,
  `session_expired`, and default. The `locked` variant computes a
  remaining duration from `session.user.locked_until` when present.
- `apps/web/src/auth.ts` declares and exports
  `class AccountLockedError extends CredentialsSignin` with
  `code = "account_locked"`. The locked-account branch in
  `authorize()` throws this. The pre-existing spec 161 audit row
  still fires before the throw.
- `apps/web/src/app/login/actions.ts` catches AuthError with
  `code === "account_locked"` and `redirect("/forbidden?reason=locked")`.
- All five spec-kit files exist under
  `specs/170-redis-singleton-and-error-pages/`.
- `tests/governance/test_170_redis_singleton_and_error_pages.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No new dependency.** Reuses the existing `ioredis` (already a
  worker + web peer dep). No `redis` (the native client), no
  `cache-manager`, no presence channel.
- **No BullMQ change.** `apps/worker/src/queues.ts` keeps its own
  dedicated ioredis instance. The web-side producer calls
  (`transcodeQueue.add`, `getJobCounts`) inherit that connection
  via the worker package import — unchanged.
- **No schema delta.** No migration. The `users.locked_until`
  column was added in spec 161 (migration 0020); the forbidden page
  just reads it for the locked variant.
- **No e2e Playwright tests.** The governance test pins the source
  structure (`data-testid`, the four copy branches, the
  `searchParams.reason` plumbing). E2e coverage of the four
  rendered variants is out of scope.
- **No middleware reason-passing.** Spec 150's role-gate rewrite to
  `/forbidden` continues to pass no `reason=`, so role-gate failures
  render the default copy. Future specs that identify a NEW reason
  cause from middleware (e.g. tenant-suspended, schedule-window) can
  add their own `?reason=<x>` and a new branch in the page.
- **No i18n.** The four copy strings are English-only. The LMS's
  ui-language picker (spec 155) doesn't yet translate the forbidden
  page — a future spec adding translations for the chrome can pick
  these up.
