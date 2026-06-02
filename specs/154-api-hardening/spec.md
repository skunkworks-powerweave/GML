# Spec 154 — API hardening (Workflow Run 14 audit-closure MEDIUM)

## Why

The 7-agent audit at the close of Workflow Run 13 flagged four MEDIUM
severity gaps in the API surface area shipped during Run 12. Each gap
is the kind of low-impact-per-call / high-impact-in-aggregate hole that
the previous CRITICAL+HIGH closures (specs 141-149, committed
`ee3991e`) didn't sweep up because the individual symptoms looked
benign in isolation. Aggregated together they are a coherent surface
worth closing in a single hardening pass:

1. **`/api/uploads/tus` — no auth gate on any method handler.** Spec
   038 shipped the tus proxy with an implicit assumption that Caddy
   would terminate unauthenticated traffic in production. The dev
   stack has no such backstop, and `pnpm dev` exposes the route on
   `localhost:3000` open to any process on the box. An anonymous POST
   allocates a tus upload slot against the MinIO bucket (storage
   quota DoS); an anonymous PATCH can write bytes into another user's
   in-flight upload (the upload ID is monotonically increasing and
   guessable on a quiet box). The fix is to call `auth()` at the top
   of every method handler and reject `!session?.user` with a 401.

2. **`/api/uploads/tus` 501 response leaks the env var name.** The
   501 branch returns
   `{ error: "tusd_not_configured", hint: "Set TUSD_INTERNAL_URL=http://tusd:1080 in .env" }`.
   That hint surfaces both the env var name and the internal hostname
   /port to an unauthenticated probe. The fix collapses the response
   to `{ error: "tusd_unavailable" }` and moves the diagnostic to a
   `console.warn` line that ops can see via journalctl / docker logs
   but an attacker cannot.

3. **`/api/form-drafts/[id]` swallows malformed JSON.** The PUT
   handler shipped with
   `(await req.json().catch(() => ({}))) as Record<string, unknown>`.
   When the body fails to parse, the call routes through the Zod
   schema with an empty object, which then returns 400
   `validation_failed`. The 400 is a correct response code, but the
   client (and the observability tooling) cannot distinguish a
   wire-level failure (truncated body, content-encoding mismatch)
   from a schema-level one (missing `responses` key). The fix is to
   surface the JSON parse failure as its own explicit
   `{ error: "invalid_json", message: <truncated err string> }` so
   the two failure modes are diagnosable independently.

4. **`/api/helpdesk/tickets` has no rate limit.** Spec 122 shipped the
   ticket-open endpoint with an authenticated gate but no throttle. A
   logged-in user (or anyone with a compromised session) can hammer
   the endpoint, flooding every programme_admin's inbox with helpdesk
   notifications. The notification rows are bounded in size by the
   500-char body schema but the row count itself is unbounded. The
   fix uses the existing `rateLimit` helper with bucket `helpdesk`,
   id `session.user.id`, limit 5 per 60 minutes. On limit-hit the
   handler returns 429 with a `Retry-After` header and an audit row;
   on Redis fault the handler fails OPEN so a transient infra outage
   doesn't lock real stuck users out of asking for help (the abuse
   path still leaves an audit trail).

## What we ship

### `apps/web/src/app/api/uploads/tus/route.ts` (EDITED)

- New `requireAuth()` helper at module top calls `auth()` and returns
  the user or `null`. Single helper so every method handler enforces
  the same 401 contract.
- New `tusdUnavailable()` helper logs the diagnostic via
  `console.warn` and returns the flat `{ error: "tusd_unavailable" }`
  body. The previous `hint` field is gone.
- Every method handler (GET / POST / HEAD / PATCH / DELETE) now early
  -returns 401 when `requireAuth()` returns null. GET and DELETE are
  added as explicit handlers (the previous file had only POST / HEAD
  / PATCH) so the auth gate covers every shape an attacker can probe.

### `apps/web/src/app/api/form-drafts/[id]/route.ts` (EDITED)

- The PUT handler's silent `.catch(() => ({}))` is replaced with an
  explicit `try { body = await req.json() } catch (err) { return 400
  invalid_json }` block. The error string is forwarded (via
  `String(err)`) so the client can log it for diagnostics.
- The schema-validation 400 (Zod) is unchanged — only the
  JSON-parse-failure path is rewritten.

### `apps/web/src/app/api/helpdesk/tickets/route.ts` (EDITED)

- New import: `import { rateLimit } from "@/lib/rate-limit"`.
- Two new constants `HELPDESK_LIMIT = 5` and
  `HELPDESK_WINDOW_MS = 60 * 60 * 1000` document the throttle policy
  in source.
- A new try/catch block immediately after the auth gate calls
  `rateLimit({ bucket: "helpdesk", id: userId, limit, windowMs })`.
  On `!rl.ok` the handler audits `helpdesk.ticket_rate_limited` and
  returns 429 with `Retry-After`. On Redis fault the handler logs
  and falls through (fail-open for help-arrival).

## Acceptance criteria

- `/api/uploads/tus/route.ts` imports `auth` from `@/auth`.
- Every exported HTTP method handler in `/api/uploads/tus/route.ts`
  calls `auth()` (or the `requireAuth()` helper that wraps it) and
  early-returns 401 when there is no session.
- The 501 response body is `{ error: "tusd_unavailable" }` — no
  `TUSD_INTERNAL_URL` string and no `hint` field in the response.
- `/api/form-drafts/[id]/route.ts` PUT handler no longer contains
  `req.json().catch(() => ({}))`. The replacement try/catch returns
  `{ error: "invalid_json", message: ... }` with status 400.
- `/api/helpdesk/tickets/route.ts` imports `rateLimit` from
  `@/lib/rate-limit`.
- The POST handler in `/api/helpdesk/tickets/route.ts` calls
  `rateLimit` with bucket `"helpdesk"`, id `userId`, limit `5`,
  windowMs `60 * 60 * 1000`.
- On `!rl.ok` the handler returns status 429 with a `Retry-After`
  header.
- All five spec-kit files exist under `specs/154-api-hardening/`.
- `tests/governance/test_154_api_hardening.test.mjs` passes with at
  least ten assertions.

## Non-goals

- **No schema change.** Every fix lives in route-handler source. The
  next migration index (0018) remains reserved for the spec that
  actually touches the DB.
- **No new dependencies.** `rateLimit` already ships from
  `@/lib/rate-limit`; `auth()` already ships from `@/auth`. No new
  packages added to `apps/web/package.json`.
- **No change to the legitimate helpdesk path.** A user opening a
  real ticket sees zero change. The throttle only kicks in past
  5 tickets in an hour, which is far beyond the realistic ceiling.
- **No change to the tus proxy contract.** When `TUSD_INTERNAL_URL`
  is set and the request is authenticated, the proxy passes through
  exactly as before. Only the unauthenticated and unconfigured
  branches change.
- **No retroactive cleanup of pre-existing helpdesk tickets.** The
  rate limit applies forward-only. Any spam that already landed in
  programme_admin inboxes is left alone — sweeping it would race the
  legitimate-vs-spam classification problem that this spec is
  deliberately punting on.
