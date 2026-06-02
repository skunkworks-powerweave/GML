# Spec 141 — Auth fail-closed and gate audit (Workflow Run 13 audit-closure)

## Why

The Workflow Run 13 audit (7 agents, 10 dimensions, ~50 findings)
surfaced two HIGH-severity defects that, taken together, hand an
attacker a silent path around two of our most important security
controls.

**Issue 1 — `verifyGate()` never emits an audit row.** The gate
verification server action at
`apps/web/src/app/gate/[slug]/actions.ts` writes a
`section_gate_grants` row on success but never calls `recordAudit`.
The `/admin/gates` dashboard at
`apps/web/src/app/(authenticated)/admin/gates/page.tsx` queries
`audit_log.action IN ('gate.attempt.success', 'gate.attempt.fail',
'gate_pass', 'gate_fail')` to compute the 30-day attempts and
failures columns — the legacy `gate_pass` / `gate_fail` actions were
emitted by an older code path that no longer runs, and the new
dotted-notation actions documented in `docs/audit-actions.md` are
never written. Net effect: every gate card on `/admin/gates` shows
`0` attempts and `0` failures regardless of real activity. A
brute-force attempt against the observation or mentorship password
is invisible to the only dashboard that would surface it.

**Issue 2 — Rate-limit fails OPEN on Redis errors.** Both
`apps/web/src/auth.ts:80` (login) and
`apps/web/src/app/gate/[slug]/actions.ts:47-49` (gate) wrap their
`rateLimit()` call in `try { ... } catch { /* allow */ }`. If Redis
is partitioned or its connection saturates, every login and every
gate verification skips the 5-per-15-minute throttle without a
single audit row recording the degraded state. An attacker who can
exhaust Redis (e.g. a slow-DoS against the cache, or a cluster
maintenance window) gets unbounded password guessing on both
channels. The degraded state is also invisible to ops — no audit
row, no metric, no log spike.

Spec 141 closes both findings together because they share the same
codepaths, the same `recordAudit` helper, and the same threat
model (silent failures around section-gate password verification).
The change is the inverse of the current behaviour: previously
failures were silent + fail-open; now they audit + fail-closed.

## What we ship

### 1. `apps/web/src/lib/audit.ts` (EDITED)

`recordAudit` signature change: `Promise<void>` → `Promise<boolean>`.

- Returns `true` when the audit row was committed.
- Returns `false` when the insert failed (DB down, schema mismatch).
- Never throws — the boolean is the only error channel.

Two optional inputs are added:

- `userId?: string` — override the request-scope `auth()` lookup,
  used by the login flow (which has no session yet when it audits).
- `ipOverride?: string` — override the request-scope `headers()`
  IP extraction. Same reason.

Both overrides are optional; absent them, the existing
request-scope behaviour applies. The internal `auth()` / `headers()`
calls are each wrapped in their own try/catch so a missing request
scope (e.g. background job calling `recordAudit`) downgrades to
"insert without that field" rather than dropping the row entirely.

### 2. `apps/web/src/auth.ts` (EDITED)

Three changes:

- Import `recordAudit` from `@/lib/audit`.
- Add a private `maskIp(ip)` helper that drops the last IPv4 octet
  or the last IPv6 hextet so the audit row carries enough to count
  distinct sources without identifying a single household.
- Replace the silent `catch { /* allow */ }` on the rate-limit call
  with: emit a SEVERE `auth.rate_limit.redis_down` audit row, then
  `return null` (fail-closed). The audit metadata records
  `{ method: "credentials", ipMasked: maskIp(ip), severity:
  "SEVERE", error: <truncated stringified error> }`. No plaintext
  password ever enters the metadata.

The user-facing failure path is unchanged: `authorize` returns
`null`, NextAuth renders the generic credential-failure copy. The
degraded state is not leaked to attackers probing for the weakness.

### 3. `apps/web/src/app/gate/[slug]/actions.ts` (EDITED)

Six changes:

- Import `recordAudit` from `@/lib/audit`.
- Introduce a `SERVICE_UNAVAILABLE` constant so the generic outage
  copy lives in one place and can never accidentally diverge from
  the auth-side string.
- Track `rateLimited` and `attemptCount` across the action body so
  the audit metadata for both success and failure paths can
  accurately reflect throttle state.
- On rate-limit refusal (rl.ok === false): emit
  `gate.attempt.fail` with metadata
  `{ slug, attemptCount, rateLimited: true, reason:
  "rate_limit_exceeded" }`, then return the existing
  "Too many attempts…" copy.
- On Redis error: emit a SEVERE `gate.rate_limit.redis_down` audit
  row, then return `{ error: SERVICE_UNAVAILABLE }`. Fail-closed.
- On wrong password (bcrypt.compare returns false): emit
  `gate.attempt.fail` with metadata
  `{ slug, attemptCount, rateLimited, reason: "wrong_password" }`,
  then return the existing "Wrong password." copy. Plaintext never
  enters metadata.
- On success (after the section_gate_grants INSERT): emit
  `gate.attempt.success` with metadata
  `{ slug, attemptCount, rateLimited }`. Fired BEFORE the cookie
  set + redirect so a redirect-induced exception doesn't suppress
  the audit row.

### 4. `docs/audit-actions.md` (EDITED)

The `gate.*` row gains `gate.rate_limit.redis_down`; a new `auth.*`
row documents `auth.rate_limit.redis_down`. Spec 141 cross-ref so
the next person reading the taxonomy can find the rationale.

## Acceptance criteria

- `recordAudit` returns `Promise<boolean>` — `true` on insert,
  `false` on caught failure.
- `recordAudit` accepts optional `userId` and `ipOverride` inputs;
  when absent, request-scope `auth()` / `headers()` behaviour is
  preserved.
- `apps/web/src/auth.ts` imports `recordAudit` and `maskIp`
  exists; the Redis-down branch returns `null` AND emits an
  `auth.rate_limit.redis_down` audit row tagged
  `severity: "SEVERE"` with metadata
  `{ method: "credentials", ipMasked, severity, error }`.
- The login Redis-down branch does NOT contain the previous
  fail-open comment ("don't lock everyone out"); the comment is
  rewritten to document the fail-closed contract.
- `apps/web/src/app/gate/[slug]/actions.ts` imports
  `recordAudit`; the Redis-down branch emits
  `gate.rate_limit.redis_down` (severity SEVERE) and returns
  `{ error: "Service temporarily unavailable." }`.
- `verifyGate` emits `gate.attempt.success` on the success path
  AND `gate.attempt.fail` on at least the wrong-password +
  rate-limit-exceeded paths, with metadata `{ slug, attemptCount,
  rateLimited, ... }`.
- No `metadata: { ... }` block in either file contains the token
  `password`, `plaintext`, or `passwordHash` — plaintext never
  leaks into audit rows.
- `docs/audit-actions.md` lists `gate.rate_limit.redis_down` and
  the new `auth.*` family.
- All five spec-kit files exist under
  `specs/141-auth-fail-closed-and-gate-audit/`.
- `tests/governance/test_141_auth_fail_closed_and_gate_audit.test.mjs`
  passes with at least ten assertions covering the above.

## Non-goals

- **No new schema.** `audit_log` already takes free-form
  `varchar(64)` actions (spec 021). No migration is needed for the
  new action names.
- **No new dependencies.** The fix uses the existing `recordAudit`
  helper, the existing `rateLimit` helper, and standard Node
  string operations.
- **No change to the user-facing rate-limit copy.** "Too many
  attempts. Try again in N minutes." stays; only the Redis-down
  branch gets a new generic outage string so the failure mode
  doesn't leak.
- **No retry / circuit breaker.** A genuinely down Redis breaks
  login until ops restores it — by design. The audit row tells
  ops the channel is degraded; a circuit breaker would mask the
  outage from the dashboard.
- **No backfill of historical gate attempts.** The
  `gate.attempt.success` / `gate.attempt.fail` rows start with
  this deploy. The `/admin/gates` dashboard's 30-day counters
  ramp up over the next 30 days.
- **No mass refactor of other recordAudit callers.** The
  `Promise<boolean>` return is additive — existing
  `void recordAudit(...)` callers stay correct and continue to
  discard the boolean. We do not chase down 50+ sites to switch
  them to `if (!await recordAudit(...))` patterns; those sites
  are fire-and-forget by design.
