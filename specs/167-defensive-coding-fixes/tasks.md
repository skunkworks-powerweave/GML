# Tasks — spec 167 defensive-coding fixes

## T-001 — Add `noteAuditDegraded` and counter to `lib/audit.ts`
- File: `apps/web/src/lib/audit.ts`
- Add module-scoped `let auditDegradedCount = 0`
- Export `noteAuditDegraded(callsite: string): void` (console.error + bump)
- Export `getAuditDegradedCount(): number` (read-only accessor)
- Export `__resetAuditDegradedCountForTests(): void` (test-isolation hook)

## T-002 — Export BCRYPT_COST from `lib/password.ts`
- File: `apps/web/src/lib/password.ts`
- Rename `const COST = 10` to `export const BCRYPT_COST = 10`
- Update `hashPassword` to consume `BCRYPT_COST`
- Add a top-of-file comment block explaining the single-source-of-truth contract

## T-003 — FormRenderer: throw instead of console.error
- File: `apps/web/src/components/forms/FormRenderer.tsx`
- Inside the `process.env.NODE_ENV !== "production" && action && onSubmit`
  branch, replace the `console.error(...)` call with
  `throw new Error("FormRenderer: pass either \`action\` (server) or \`onSubmit\` (client), not both.")`
- Keep the dev-only guard so production silently picks `action`

## T-004 — Gate rotation route
- File: `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts`
- Import `BCRYPT_COST` from `@/lib/password`
- Import `noteAuditDegraded` from `@/lib/audit`
- Replace `bcrypt.hash(plaintext, 10)` with `bcrypt.hash(plaintext, BCRYPT_COST)`
- Replace `void recordAudit(...)` with `const auditOk = await recordAudit(...)`
- Add `if (!auditOk) noteAuditDegraded("/api/admin/gates/[slug]/rotate");`

## T-005 — Forgot-password route
- File: `apps/web/src/app/api/auth/forgot-password/route.ts`
- Remove local `const BCRYPT_COST = 10`
- Import `BCRYPT_COST` from `@/lib/password`
- Import `noteAuditDegraded` from `@/lib/audit`
- Capture the matched-path audit boolean and call `noteAuditDegraded`

## T-006 — Reset-password route
- File: `apps/web/src/app/api/auth/reset-password/route.ts`
- Import `{ hashPassword, BCRYPT_COST }` from `@/lib/password`
- Import `noteAuditDegraded` from `@/lib/audit`
- Add `bcryptCost: BCRYPT_COST` to the success-path audit metadata
- Capture the audit boolean and call `noteAuditDegraded`

## T-007 — Learners export route
- File: `apps/web/src/app/api/admin/learners/export/route.ts`
- Import `noteAuditDegraded` from `@/lib/audit`
- Capture the SM-9 bulk-export audit boolean and call `noteAuditDegraded`

## T-008 — Audit-log export route
- File: `apps/web/src/app/api/admin/audit/export/route.ts`
- Import `noteAuditDegraded` from `@/lib/audit`
- Capture the audit-bulk-export audit boolean and call `noteAuditDegraded`

## T-009 — Seed.ts mirror comment
- File: `packages/db/src/scripts/seed.ts`
- Add a Spec-167 comment next to the literal `bcrypt.hash(password, 10)`
  call explaining the value mirrors `apps/web/src/lib/password.ts` BCRYPT_COST

## T-010 — Spec-kit files
- `specs/167-defensive-coding-fixes/spec.md` (this folder)
- `specs/167-defensive-coding-fixes/plan.md`
- `specs/167-defensive-coding-fixes/research.md`
- `specs/167-defensive-coding-fixes/quickstart.md`
- `specs/167-defensive-coding-fixes/tasks.md`

## T-011 — Governance test
- File: `tests/governance/test_167_defensive_coding_fixes.test.mjs`
- At least 8 assertions:
  1. FormRenderer.tsx contains `throw new Error` inside the dev-mode guard
  2. lib/password.ts exports `BCRYPT_COST`
  3. gates/rotate route imports BCRYPT_COST
  4. forgot-password route imports BCRYPT_COST
  5. reset-password route imports BCRYPT_COST
  6. gates/rotate route captures `recordAudit` boolean
  7. learners/export route captures `recordAudit` boolean
  8. audit/export route captures `recordAudit` boolean
  9. forgot-password route captures `recordAudit` boolean
  10. reset-password route captures `recordAudit` boolean
  11. audit.ts exports `noteAuditDegraded` and `getAuditDegradedCount`
  12. seed.ts carries the Spec-167 mirror comment
  13. All 5 spec-kit files exist
