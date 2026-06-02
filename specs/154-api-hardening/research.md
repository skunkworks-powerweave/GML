# Research 154

Five design choices, documented inline in the touched files and
expanded here.

## (1) Why a `requireAuth()` helper instead of inlining `auth()` in every handler

Five method handlers (GET / POST / HEAD / PATCH / DELETE) all need
the same 401-on-missing-session check. We had two options:

- **Inline `auth()` in each handler.** Short and direct. Five copies
  of the same five-line block.
- **A single `requireAuth()` helper at module top.** One place to
  audit, one place to evolve (e.g. if we later want to scope the
  upload route to specific roles).

We chose the helper. The cost is one extra function declaration; the
benefit is that a future contributor adding (say) `OPTIONS` knows
exactly which line to call and the test gate can pin the IMPORT (one
assertion) rather than five copies of the inline `await auth()`
expression. The helper returns `session.user` rather than the full
session so callers can use it for downstream `session.user.id`
lookups when needed — currently no handler uses the returned value,
but the shape leaves room for it.

A simpler `requireSession()` returning a boolean was considered and
rejected: returning the user object is strictly more flexible and the
type narrowing (`User | null` → `User`) reads more naturally at the
call site than a boolean + a separate `auth()` call.

## (2) Why `console.warn` for the tusd-unavailable diagnostic

The previous response embedded `Set TUSD_INTERNAL_URL=http://tusd:1080`
in the body. Three reasons to move it server-side:

- **Information disclosure.** The env var name + hostname/port are
  configuration leaks. An attacker probing the endpoint learns the
  internal service name and the standard port, both of which are
  inputs to a port-scan or a credential-stuffing attempt against the
  internal tusd instance.
- **Ops visibility.** A `console.warn` lands in journalctl /
  `docker logs`, which is where on-call engineers actually look. A
  client-facing hint is invisible to ops unless they happen to grep
  client error logs.
- **No log spam.** The 501 only fires when `TUSD_INTERNAL_URL` is
  unset, which is a startup-time configuration state, not a
  per-request runtime state. The warn-per-call shape is fine — at the
  steady-state of a healthy deployment, the line never fires.

We didn't use `console.error` because the 501 isn't an error from the
LMS's perspective — it's a documented "this dev box doesn't have tusd
running" state. `console.warn` is the right severity for "ops should
fix this if you intended uploads to work".

## (3) Why surface the JSON parse error verbatim (`String(err)`)

The fix's response body is:

```json
{ "error": "invalid_json", "message": String(err) }
```

The `String(err)` forwards the underlying parser's diagnostic
("Unexpected token \\}", "Unterminated string in JSON", etc.). Two
trade-offs:

- **Leak risk.** The parser's message can in principle echo a slice
  of the input back. For our case the input is a JSON body the
  caller already controls, so the only echo is into the caller's own
  attack — no cross-user information disclosure.
- **Diagnostic value.** A bare `{ "error": "invalid_json" }` would
  force the client into a guessing game ("did I forget a comma? did
  the server cut me off mid-stream?"). The verbatim message
  collapses that game to a one-line console log on the client side.

The Zod schema-validation 400 body already contains `issues` (the
full Zod issue array) so this is consistent with the surrounding
shape — both failure modes are diagnosable from the response.

## (4) Why fail-OPEN on Redis fault in the helpdesk throttle

The gate-password spec (141) fails CLOSED on Redis fault — a Redis
outage there means "treat every attempt as throttled" because the
threat is unbounded password guessing.

For the helpdesk ticket endpoint the threat model is different:

- **Closed threat:** a logged-in user spamming the
  programme_admin inbox.
- **Open threat:** Redis is genuinely down and a stuck mentor
  cannot reach support.

We chose to fail open because the secondary path (audit row) still
records every ticket, so abuse remains visible after-the-fact even
when the throttle is degraded. The closed-fail-on-redis-down
posture would block a legitimate "I can't access my course, please
help" ticket the one day a year Redis is having a bad time — and a
support-arrival path that fails closed during an incident is the
exact UX the system is designed to avoid.

The audit row inserted on rate-limit hits (`helpdesk.ticket_rate_limited`)
is the deterrent for the closed threat: a programme_admin reviewing
the audit trail sees the abuse pattern even when Redis was up.

## (5) Why 5 tickets / hour / user and not (e.g.) 1 / minute

Three rationales for the 5/hour cap:

- **Realistic ceiling.** A genuinely stuck mentor opens 1-2 tickets
  before they reach a human (the typical pattern is: open ticket,
  WhatsApp the admin, get a reply, close the loop). Five is 2-5x
  the realistic ceiling.
- **Sliding window plays nicely with bursts.** The
  `rate-limit.ts` helper is a sliding window — `5 in 60min` means
  bursts of 2-3 tickets in 10 minutes are fine if the prior 50
  minutes were quiet. A `1/minute` cap would block a frustrated
  mentor's typo-rapidly-resubmitting pattern.
- **Programme_admin throughput.** The downstream is human-paced —
  an admin reads ~5 tickets in an hour. Letting more through would
  flood the inbox faster than humans can drain it.

The constants `HELPDESK_LIMIT` and `HELPDESK_WINDOW_MS` are exported
in their own block so a future tweak (say after we have real usage
data) is a one-line edit.
