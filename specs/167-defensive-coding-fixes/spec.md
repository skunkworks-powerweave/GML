# Spec 167 — Defensive-coding fixes (Workflow Run 16 follow-up sweep)

## Why

The fresh audit after the 163 NITS round closed surfaced three small but
real defensive-coding regressions hiding in plain sight. None is a behaviour
bug today, but each is the kind of half-wired guard that turns into a
silent production miss on the day someone actually triggers it:

1. **`FormRenderer` dev assertion uses `console.error`.** The
   action-vs-onSubmit discriminated-union guard in
   `apps/web/src/components/forms/FormRenderer.tsx` (introduced in spec 142)
   logs a `console.error` when both props are passed simultaneously. In
   practice a noisy `console.error` scrolls past unread; a developer who
   wires both for previewing-while-converting can ship a silent
   double-submit. The assertion needs to be loud enough to fail tests and
   crash the dev render — a `throw` does that, a `console.error` does not.

2. **`BCRYPT_COST` is a literal `10` duplicated across five sites.** Each of
   the five places we bcrypt a secret (`lib/password.ts`, gate rotation,
   forgot-password token, reset-password write, seed bootstrap) hardcodes
   the cost as `10`. The day someone bumps the cost to 12 (the SOC-2
   hardening guide recommends 12 for any system with >100 daily logins) the
   refactor has to find five literals and march them in lockstep. One
   missed site is a measurable but undetected verify-path mismatch. Pulling
   the value out to an exported const is the textbook fix.

3. **`recordAudit` boolean return is silently discarded by high-stakes
   callers.** Spec 141 changed the `recordAudit` return type from
   `Promise<void>` to `Promise<boolean>` so callers could detect a degraded
   audit channel. The auth path already wires the boolean. But four
   high-stakes call sites (gate rotation, bulk PII export, audit export,
   password reset) kept the `void recordAudit(...)` shape, which discards
   the new boolean — and so silently miss the very degradation signal the
   spec 141 contract was supposed to surface. A missed audit row on any of
   these four flows is a forensic-trail gap nobody sees until an incident.

## What we ship

### `apps/web/src/components/forms/FormRenderer.tsx` (EDITED)

The dev-mode guard changes from `console.error(...)` to `throw new Error(
"FormRenderer: pass either `action` (server) or `onSubmit` (client), not
both.")`. The throw is wrapped in `if (process.env.NODE_ENV !==
"production")` so production silently picks `action` (the native
`<form action={...}>` path) and the click goes through cleanly rather than
crashing the page. Dev / test catch the programming mistake immediately.

### `apps/web/src/lib/password.ts` (EDITED)

The literal `const COST = 10` becomes `export const BCRYPT_COST = 10`.
`hashPassword` continues to consume `BCRYPT_COST` internally; the export
makes the value reachable by every other caller that hashes a secret.

### `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` (EDITED)

Imports `BCRYPT_COST` from `@/lib/password` and replaces the literal `10`
in the `bcrypt.hash(plaintext, 10)` call. The `void recordAudit(...)`
becomes `const auditOk = await recordAudit(...)` and a `!auditOk` branch
calls a new `noteAuditDegraded("/api/admin/gates/[slug]/rotate")` helper.
The rotation itself never blocks on audit failure — the helper is loud
console.error + counter bump only.

### `apps/web/src/app/api/auth/forgot-password/route.ts` (EDITED)

Replaces the local `const BCRYPT_COST = 10` with an import from
`@/lib/password`. The `void recordAudit(...)` on the matched-email path
becomes a captured-boolean check that calls `noteAuditDegraded()` on
`false`.

### `apps/web/src/app/api/auth/reset-password/route.ts` (EDITED)

Imports `BCRYPT_COST` alongside `hashPassword` from `@/lib/password` (the
hash itself goes through `hashPassword(password)` which already uses the
const internally; the explicit import documents the dependency and lets
the audit metadata record which cost the new hash was generated at). The
final `void recordAudit(...)` becomes a captured-boolean check that
records `bcryptCost: BCRYPT_COST` and calls `noteAuditDegraded()` on
failure.

### `apps/web/src/app/api/admin/learners/export/route.ts` (EDITED)

The `void recordAudit(...)` becomes a captured-boolean check with
`noteAuditDegraded("/api/admin/learners/export")` on failure. This is the
SM-9 PII bulk-export hook — the highest-severity forensic-trail surface
in the LMS.

### `apps/web/src/app/api/admin/audit/export/route.ts` (EDITED)

Same captured-boolean upgrade for the audit-log export's own audit row.
Recursively meta: a failed audit-of-the-audit-export is the only signal
anyone has that the channel is degraded mid-incident, so the boolean
check is unusually load-bearing here.

### `apps/web/src/lib/audit.ts` (EDITED)

Adds two new exports:

- `noteAuditDegraded(callsite: string): void` — `console.error`s the miss
  with the supplied callsite tag and increments a process-local counter.
- `getAuditDegradedCount(): number` — reads the counter so a future admin
  diagnostic surface or Prometheus exporter can surface the degraded count
  without exposing a setter.

Both are pure additions; the existing `recordAudit` / `withAudit` exports
keep their spec-141 contract unchanged.

### `packages/db/src/scripts/seed.ts` (EDITED)

The seed's `bootstrapSuperAdmin` keeps the literal `10` (cross-workspace
import from `apps/web` would invert the dep direction) but gains an
inline `Spec 167` paragraph documenting that the value mirrors
`BCRYPT_COST` in `apps/web/src/lib/password.ts` and that a future cost
bump must edit both. The governance test pins both the export and the
mirror comment so the drift is caught at test time.

## Acceptance criteria

- `FormRenderer.tsx` contains `throw new Error(...)` inside the
  `process.env.NODE_ENV !== "production"` guard when both `action` and
  `onSubmit` are passed; the prior `console.error` shape is removed.
- `lib/password.ts` exports `BCRYPT_COST` and `hashPassword` consumes it.
- `gates/[slug]/rotate/route.ts` imports `BCRYPT_COST` and uses it in the
  `bcrypt.hash(...)` call.
- `forgot-password/route.ts` imports `BCRYPT_COST` and uses it in the
  reset-token hash.
- `reset-password/route.ts` imports `BCRYPT_COST` (records it in the audit
  metadata).
- `gates/rotate`, `learners/export`, `audit/export`, `forgot-password`,
  and `reset-password` all capture the `recordAudit` boolean return and
  call `noteAuditDegraded()` on `false`.
- `audit.ts` exports `noteAuditDegraded` and `getAuditDegradedCount`.
- The full test suite (1423 tests) still passes after these edits.
- The five spec-kit files exist under `specs/167-defensive-coding-fixes/`.
- `tests/governance/test_167_defensive_coding_fixes.test.mjs` passes with
  at least 8 assertions covering the above.

## Non-goals

- **No new dependencies.** Every fix is a defensive shape change inside
  existing files; the `noteAuditDegraded` helper is a hand-rolled counter,
  not a Prometheus client or stats library.
- **No schema delta.** No migration index is advanced.
- **No production behaviour change.** The `throw` is dev-only; the bcrypt
  cost is unchanged; the audit-degraded counter is observation-only and
  does not roll back any business flow.
- **No expansion of the high-stakes audit list.** The four call sites
  named here are the ones the audit explicitly flagged. A future pass can
  expand to other high-stakes endpoints (helpdesk PII writes, mentor CSV
  export, etc.) but scope is the four named today.
- **No re-shape of `recordAudit`.** Its spec-141 `Promise<boolean>`
  signature is unchanged; this spec only re-wires the callers.
