# Research 141

Five design choices documented inline in the touched files.

## (1) Fail-closed vs fail-open on Redis errors

Both auth and gate previously caught Redis errors and continued
the request as if the rate-limit had passed. The rationale at the
time was "don't lock everyone out on a Redis hiccup". The Workflow
Run 13 audit reframed this:

- The Indian deployment runs a single Redis instance, not a
  cluster. A genuine outage is rare (≤ 1×/quarter) but recoverable
  in minutes once detected. The cost of a 5-minute global login
  outage is ops paging at most once a quarter.
- The cost of the previous fail-open posture is uncapped: an
  attacker who can saturate Redis (or who happens to attack during
  a maintenance window) gets unbounded login + gate-password
  guessing on every account, with no audit trail recording the
  bypass.
- We're a small-population system (≤ 200 mentors, 1-2 super_admins,
  ~5 programme_admins). The blast radius of a successful brute
  force is the entire programme. The asymmetry — temporary
  inconvenience vs total compromise — overwhelmingly favours
  fail-closed.

The decision: rate-limit channel down ⇒ deny + audit. Ops sees the
audit row (and the alert wired up downstream, separate spec), fixes
Redis, login resumes. The user sees a generic outage message that
does not let an attacker probe for the failure mode.

## (2) Why we audit on EVERY gate failure path, not just wrong-password

The `/admin/gates` page expected `gate.attempt.success` and
`gate.attempt.fail` audit rows. Naively we'd only emit them when
the bcrypt comparison fires. But three other paths reach a failed
attempt:

- Rate-limit refusal (rl.ok === false) — user typed 5 wrong
  passwords already. This is the *most* important failure to log,
  because it's the brute-force fingerprint. Reason:
  `rate_limit_exceeded`.
- Wrong password (bcrypt false) — the bog-standard failure. Reason:
  `wrong_password`.
- Redis fault — emits the SEVERE
  `gate.rate_limit.redis_down` row, NOT a `gate.attempt.fail`. The
  attempt was never evaluated, so logging it as a fail would
  inflate the failure counter and trigger spurious alerts.

The metadata schema is `{ slug, attemptCount, rateLimited, reason }`
for fails and `{ slug, attemptCount, rateLimited }` for successes.
`attemptCount` is computed from `5 - rl.remaining` so the
dashboard can sort by hot accounts without scanning the audit log
sequentially.

## (3) Why `recordAudit` returns Promise<boolean> instead of throwing

`recordAudit` is called from 58 files across the codebase. Most
callers use `void recordAudit(...)` because the audit failure is
intentionally non-blocking — a dashboard hit shouldn't 500 because
the audit insert raced with a DB restart. Throwing from
`recordAudit` would force every caller to add its own try/catch
boilerplate.

The boolean return preserves the fire-and-forget contract for the
58 existing call sites while giving the new high-risk sites
(auth, gate, future security-sensitive paths) an opt-in signal
to fail-closed when the audit channel itself is degraded.

This is a strictly additive change — `void recordAudit(...)`
continues to work because `void` discards the boolean, and `await
recordAudit(...)` callers that previously got `void` now get a
boolean they're free to ignore.

## (4) IP masking in the auth audit row

The login flow's Redis-down audit row carries the request IP. A
raw IP in the audit log is enough to:

- Track a single household across sessions even when they log out.
- Cross-reference against carrier IP-allocation tables to identify
  a single subscriber.

Masking the last IPv4 octet (`.xxx`) or the last IPv6 hextet
(`:xxxx`) retains enough resolution to:

- Group attempts by /24 or /112 — a brute-force from one /24 still
  looks like a brute-force from one /24.
- Distinguish a deployment-wide outage (every /24 hitting the
  Redis-down branch simultaneously) from a targeted attack.

…without retaining the per-household resolution that the audit
log otherwise has no business carrying. The full IP is still
captured in the `ip` column at the row level (via the request
scope) for legitimate non-Redis-down rows.

## (5) Why the gate-success audit fires before the cookie + redirect

The original action structure was: write the
`section_gate_grants` row → set the cookie → `redirect(next)`.
`redirect()` throws a Next.js `NEXT_REDIRECT` sentinel error that
short-circuits the rest of the function. If we put
`recordAudit("gate.attempt.success", ...)` after the redirect, the
audit row would never be emitted. If we put it after the cookie
set but before the redirect, a (rare) cookie-write fault would
still suppress the audit.

The chosen order: grant insert → audit row → cookie set →
redirect. The audit is fire-and-forget (`void recordAudit`) so it
doesn't block the redirect; it's emitted between the durable
side-effect (the grant row) and the redirect throw. This matches
the pattern used in `/api/admin/gates/[slug]/rotate/route.ts`
(spec 115).
