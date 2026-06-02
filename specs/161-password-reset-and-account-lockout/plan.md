# Spec 161 — Plan

## Surface area

CREATED:
- `packages/db/src/migrations/0020_password_reset_and_lockout.sql`
- `apps/web/src/app/login/forgot/page.tsx`
- `apps/web/src/app/login/reset/page.tsx`
- `apps/web/src/app/api/auth/forgot-password/route.ts`
- `apps/web/src/app/api/auth/reset-password/route.ts`
- `apps/web/src/app/api/admin/users/[id]/unlock/route.ts`
- `specs/161-password-reset-and-account-lockout/{spec,plan,research,quickstart,tasks}.md`
- `tests/governance/test_161_password_reset_and_account_lockout.test.mjs`

EDITED:
- `packages/db/src/schema/identity.ts` — adds `passwordResetTokens`
  table + `failedLoginCount` and `lockedUntil` columns on `users`.
- `apps/web/src/auth.ts` — wires lockout check, failed-count
  increment, success-path reset, and the three new audit actions.
- `apps/web/src/app/login/page.tsx` — comment note that the device
  shells now link to /login/forgot (no logic change here — the
  link wiring lives in DesktopLogin / MobileLogin).
- `apps/web/src/app/login/DesktopLogin.tsx` — "Forgot password?"
  href changes from `#` to `/login/forgot`.
- `apps/web/src/app/login/MobileLogin.tsx` — adds a "Forgot
  password?" Link below the credentials Sign-in button.

MIGRATED:
- `packages/db/src/migrations/meta/_journal.json` — appends idx 20,
  tag `0020_password_reset_and_lockout`. (idx 19 is spec 159's
  `0019_quiz_time_limit` per the parallel run; this spec takes 20.)

## Sequencing

1. Schema additions land first (Drizzle schema + migration SQL +
   journal entry) so the runtime code that references the new
   columns has a compilable shape to import.
2. Forgot/reset API routes and pages — they're independent of the
   lockout state machine.
3. `auth.ts` changes — the lockout state machine, which reads /
   writes the new columns.
4. Unlock endpoint — last because it depends on requireRole +
   recordAudit, both of which are existing.
5. Login UI link wiring — DesktopLogin's `#` href + MobileLogin's
   new Link.
6. Governance test — pins the contract.

## Non-changes

- `apps/web/src/lib/password.ts` is unchanged (hashPassword cost=10
  is already what the spec needs).
- `apps/web/src/lib/rate-limit.ts` is unchanged (the new bucket
  `forgot-password` is just a different `id` string, no helper
  change).
- `apps/web/src/lib/audit.ts` is unchanged (action names are
  free-form varchar(64) per spec 021; the new strings just go in).
- No new dependencies (`nodemailer`, `bcryptjs`, `crypto` are all
  already in scope).
