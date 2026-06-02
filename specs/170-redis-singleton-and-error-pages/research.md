# Research 170

Three design points; each is documented inline in the affected files
and expanded here.

## (1) Why a singleton rather than a per-call-site factory

Four shapes were on the table for sharing the ioredis client:

- **Per-call-site factory** (the pre-fix shape). Each module
  constructs its own `new Redis(url, opts)` in module scope. Cheap
  to add a new caller, but every caller picks its own defaults and
  every caller opens its own TCP connection.
- **Module-scope singleton with `getRedis()` factory** (chosen).
  One module owns the client; every caller `import { getRedis }`s.
  Defaults live in one place. Connection lifecycle is unambiguous.
- **Dependency-injected client** (passed through function args).
  Forces every call site to thread the client through. Heavy
  refactor on every existing route handler; benefit (test-time
  override) is real but small because tests already mock Redis at
  the `ioredis` module level.
- **Global on `globalThis`** (Next.js dev-mode hot-reload trick).
  Survives Fast Refresh module reloads in dev. Overkill here — the
  singleton in module scope already does the right thing in prod
  (modules are loaded once); dev-mode double-connection isn't a
  contract violation, just a minor inefficiency.

We chose the second. The singleton's defaults match the worker's
`queues.ts` shape — `maxRetriesPerRequest: null`,
`enableReadyCheck: false`, `lazyConnect: true` — so the two
processes have aligned semantics. The `lazyConnect: true` is
load-bearing: `next build` imports modules eagerly, and we don't
want the build to fail just because Redis isn't running at build
time.

The previous per-caller defaults were subtly different:

| Caller     | maxRetriesPerRequest | lazyConnect | connectTimeout |
| ---------- | -------------------: | :---------: | :------------: |
| rate-limit |                    3 |    false    |   (default)    |
| health     |                    1 |    true     |     2000ms     |
| singleton  |                 null |    true     |   (default)    |

The singleton matches the worker's choice (`null`) which means
ioredis won't auto-throw on long-running commands — the caller is
responsible for timeouts. For the rate-limit and health surfaces
this is the right call: rate-limit already wraps the call in
try/catch and treats throws as deny (spec 141 fail-closed), and
health-check has an outer abort timeout. The previous values were
artefacts of copy-paste, not deliberate per-call tuning.

## (2) Why BullMQ connections stay separate

The BullMQ Queue/Worker constructors take an ioredis instance and
treat it as PRIVATE — BullMQ subscribes to specific Redis pub/sub
channels and runs maintenance commands on the connection that
expect no interleaving from other callers. Routing BullMQ's
producer connection through the singleton would mix queue commands
with our rate-limit ZADD pipeline on the same connection, which
violates BullMQ's invariant and would break the queue under load.

The worker's `apps/worker/src/queues.ts` already owns one
`IORedis` instance scoped to the Queue handles. The web app
imports those queue handles by `import { transcodeQueue } from
"@gml/worker/queues"` — Node's module cache means there's still
one connection per web process (the worker package is loaded
once). The singleton is a SEPARATE connection used only for
direct-redis calls; the two connections are intentional.

A possible future spec could merge the two by exposing a
`getBullMQConnection()` factory that lazily-constructs a separate
IORedis-for-bullmq, then have queues.ts use that. But that's
premature — the current shape has been stable for 100+ specs.

## (3) Why the forbidden page reads searchParams rather than the cookie

Three places where the forbidden-redirect cause is known:

- **Middleware** (spec 150): role-gate rewrite, no specific cause
  identified beyond "role check failed". Stays unparameterised —
  default copy applies.
- **auth.ts `authorize()`**: the locked-account check. Cause is
  identifiable; needs to be passed forward.
- **Server actions / route handlers**: e.g. a session expired
  mid-action. Cause is identifiable; needs to be passed forward.

Four ways to pass the cause to `/forbidden`:

- **Cookie set immediately before redirect.** Read on the next
  request, then cleared. Works, but introduces a stateful
  "in-flight reason" cookie that complicates the cookie surface.
- **Session field** (`session.user.lastForbidReason`). Persists
  across the redirect, but pollutes the session shape with
  short-lived UI state — the session is supposed to be identity,
  not flow control.
- **`?reason=` query parameter** (chosen). Stateless, visible in
  URL bar (good for debuggability), trivially testable, doesn't
  require any session mutation. The URL is a 302 redirect target —
  search engines don't index `/forbidden` anyway (it's behind the
  middleware). The reason value is a known enum (`locked` /
  `smtp_unconfigured` / `session_expired`) — the page validates
  against the enum before rendering, so a bogus `?reason=foo`
  silently falls through to the default copy.
- **POST body**. The redirect is a GET — POST body doesn't survive.

The query-param approach matches the pre-existing `from=` /
`next=` shape that middleware already uses for redirects, so a
contributor reading the code finds it consistent.

## (4) The locked variant's "time remaining" computation

The spec asks for the `locked` variant to show "try again in
<timeRemaining> or contact your administrator". Three options for
the duration source:

- **From `session.user.locked_until`** (chosen). The most accurate
  — it's the exact column the auth state machine wrote. Computed
  client-server inline. Falls back to "1 hour" when the session
  doesn't carry the field.
- **From a `?until=<iso>` URL param.** Stateless but exposes the
  timestamp in the URL bar; an attacker who can read the URL
  (server logs, screenshare, browser history) sees a precise
  lockout end. Not a serious threat (lockouts are by user, not by
  attacker), but unnecessary.
- **Hardcoded "1 hour".** Matches the spec 161 default duration but
  misleads if the duration ever changes. We use this as the
  fallback only.

The fallback path (computed locked_until absent or stale) is
critical: the JWT-based session intentionally does NOT carry
`locked_until` in the token claims because we don't want to refresh
the token whenever the lockout state changes. So the fallback is
the COMMON path in practice; the precise time is only available
when we happen to have a fresh session with the column populated.

We compute via `ceil(ms / 60000)` so a 59-second lockout reads as
"1 minute" rather than "0 minutes". Minutes < 60 render as
"<N> minute(s)"; minutes >= 60 render as "<N> hour(s)". The
ceil-up bias means a user retrying right at the boundary is told
to wait a bit longer than strictly necessary — that's the right
direction (avoids them retrying just before the lockout actually
expires and seeing a confused "still locked" message).

## (5) The CredentialsSignin subclass approach for the locked signal

NextAuth v5's Credentials provider has two ways to signal failure:

- **Return null.** Generic CredentialsSignin error propagates to
  the caller. No way to distinguish locked from bad-creds.
- **Throw a `CredentialsSignin` (or subclass).** The thrown error
  carries a `code` field that survives the round-trip into the
  caller's try/catch. This is the documented "custom error code"
  shape.
- **Throw an arbitrary error.** Propagates as a generic
  AuthError — same loss of detail as return null.

We picked the subclass approach. `AccountLockedError extends
CredentialsSignin { code = "account_locked" }` makes the locked
case distinguishable in `loginAction` via
`err instanceof AuthError && err.code === "account_locked"`. The
subclass is exported from `auth.ts` so other callers (admin tools,
tests) can compare against it directly if needed.

The non-locked failure paths (return null for bad creds, return
null for rate-limit deny) are LEFT AS-IS. Differentiating them in
the user-facing error would violate the spec 141 contract that
"Redis down" and "wrong password" both produce a generic credential
failure (so an attacker can't probe the rate-limiter state).
Locked-account is a DIFFERENT signal — it's information the user
already has via their own attempt counter, so revealing it doesn't
help an attacker who isn't the legitimate account holder.

## (6) Why no middleware change for session_expired

The spec body said "Middleware (spec 150) populates the reason in
the redirect URL when known." The natural place for session_expired
detection is... NOT middleware. Middleware's branch on `!session`
sends the user to `/login` with `?from=<path>` so they can be
bounced back after re-auth. That IS the session-expired flow —
the user re-authenticates and continues, no /forbidden detour
needed.

The `/forbidden?reason=session_expired` variant is reserved for
the rarer case where a server action or API route detects an
expired session mid-flow and wants to redirect to a 403 surface
rather than the login page. None of the current handlers do this,
but the page-side branch is wired so a future spec adding the
behaviour doesn't need to revisit the rendering side.

In other words: the page is shipped with the four-way switch ready;
the middleware is left alone. The two cases the page currently
sees in practice are `locked` (from loginAction) and default (from
middleware role-gate rewrite). The other two are reserved.
