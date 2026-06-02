# Plan — spec 167 defensive-coding fixes

## Surface

- **CREATED:** none (this spec adds no new files; the helpers live alongside
  existing exports in `lib/audit.ts`).
- **EDITED:**
  - `apps/web/src/components/forms/FormRenderer.tsx` — `throw` replaces the
    `console.error` dev-mode assertion (Part A).
  - `apps/web/src/lib/password.ts` — `BCRYPT_COST` becomes an exported const
    (Part B).
  - `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` — imports
    `BCRYPT_COST` and captures the audit boolean.
  - `apps/web/src/app/api/auth/forgot-password/route.ts` — imports
    `BCRYPT_COST` and captures the matched-path audit boolean.
  - `apps/web/src/app/api/auth/reset-password/route.ts` — imports
    `BCRYPT_COST` and captures the success-path audit boolean.
  - `apps/web/src/app/api/admin/learners/export/route.ts` — captures the
    SM-9 bulk-export audit boolean.
  - `apps/web/src/app/api/admin/audit/export/route.ts` — captures the
    audit-log bulk-export audit boolean.
  - `apps/web/src/lib/audit.ts` — adds `noteAuditDegraded()` /
    `getAuditDegradedCount()` exports and the process-local counter.
  - `packages/db/src/scripts/seed.ts` — adds the Spec-167 mirror comment
    next to the literal `10`.
- **MIGRATED:** none. The spec adds no schema changes; the migration index
  remains 0020 (assigned to spec 161).

## Order of operations

1. Add the `noteAuditDegraded` / counter helpers to `lib/audit.ts` first so
   every caller below has a stable import target.
2. Export `BCRYPT_COST` from `lib/password.ts` so the four routes that need
   it can import.
3. Edit `FormRenderer.tsx` to throw instead of `console.error`. This is a
   self-contained change with no dependencies on the other fixes.
4. Edit the five high-stakes routes:
   - `gates/[slug]/rotate` — import BCRYPT_COST, replace the literal 10,
     capture the audit boolean.
   - `forgot-password` — replace the local BCRYPT_COST const with the
     import, capture the matched-path audit boolean.
   - `reset-password` — add the BCRYPT_COST import (recorded in audit
     metadata), capture the success-path audit boolean.
   - `learners/export` — capture the SM-9 audit boolean.
   - `audit/export` — capture the audit-log export's own audit boolean.
5. Add the seed.ts mirror comment.
6. Write the governance test and run it.

## Risk

- **Counter contention across requests.** The counter is process-local
  (a module-scoped `let`), so concurrent requests increment it without
  any lock. Since the counter is observational only and we only care
  about the order-of-magnitude trend ("a handful" vs "thousands"), the
  race is acceptable. A future Prometheus exporter that reads the
  counter from `/metrics` would see a slightly-stale value; that's
  fine for an alerting threshold.
- **Throw at module-level breaks SSR.** The `throw` runs inside the
  `FormRenderer` function body — every render evaluates the guard, but
  only when both `action` and `onSubmit` are truthy. The throw never
  fires on real production paths (where exactly one is set); in
  development it surfaces as the React error boundary which is the
  intended UX.
