# Spec 161 — Tasks

## T1. Schema additions

- Edit `packages/db/src/schema/identity.ts`:
  - Import `index` from `drizzle-orm/pg-core` (joins existing imports).
  - Add `failedLoginCount` and `lockedUntil` columns to the `users`
    pgTable definition. Both default to "no lockout" (0 / NULL).
  - Add a new `passwordResetTokens` pgTable with the 7 columns listed
    in the spec, the unique index on `tokenHash`, and the composite
    index on `(userId, createdAt)`.
  - Export `PasswordResetToken` + `NewPasswordResetToken` row types.

## T2. Migration

- Create `packages/db/src/migrations/0020_password_reset_and_lockout.sql`.
- The SQL has 6 statements (CREATE TABLE, ADD FK, CREATE UNIQUE
  INDEX, CREATE INDEX, ALTER TABLE ADD failed_login_count, ALTER
  TABLE ADD locked_until), separated by `--> statement-breakpoint`
  per the drizzle-kit convention.
- Append the journal entry: idx 20, tag
  `0020_password_reset_and_lockout`, `when` timestamp after 0019's.

## T3. Forgot-password API

- Create `apps/web/src/app/api/auth/forgot-password/route.ts`.
- POST handler:
  - Parse JSON body `{ email }`.
  - 400 on malformed body or missing email.
  - Read IP from forwarded headers, mask via local maskIp().
  - rateLimit({ bucket: "forgot-password", id: ip, limit: 3,
    windowMs: 60min }). Fail-CLOSED → 503 + audit
    `auth.rate_limit.redis_down`.
  - Look up user by email. If missing/inactive, audit and respond
    200 (no enumeration).
  - Generate 32-byte random token, bcrypt(10) hash, insert into
    `password_reset_tokens` with expiresAt = +30min, requestedFromIp
    = MASKED.
  - If SMTP_HOST is set, send the email with the link
    `<APP_URL>/login/reset?token=<plaintext>`.
  - Audit `auth.password.reset_requested` with matched=true.
  - Return 200 { ok: true }.

## T4. Reset-password API

- Create `apps/web/src/app/api/auth/reset-password/route.ts`.
- POST handler:
  - Parse JSON body `{ token, password }`.
  - 400 on missing fields or password < 8 chars.
  - SELECT all unconsumed-non-expired rows from
    `password_reset_tokens`; bcrypt-compare each tokenHash against
    the plaintext. First match wins.
  - 410 if no match OR if the user is no longer active.
  - In a single db.transaction: update users.passwordHash to a new
    bcrypt hash, reset failedLoginCount=0 and lockedUntil=NULL,
    stamp consumedAt = now() on the matched token row.
  - Audit `auth.password.reset_completed`.
  - Return 200 { ok: true }.

## T5. UI pages

- Create `apps/web/src/app/login/forgot/page.tsx`. Client component;
  email input, Submit, generic success state regardless of match,
  generic "try again" on 429. Link back to /login.
- Create `apps/web/src/app/login/reset/page.tsx`. Reads `token` from
  the URL; renders new-password + confirm form; POSTs to
  /api/auth/reset-password. Surface 410 → "expired or already used".

## T6. Lockout in auth.ts

- Edit the credentials provider's authorize() callback in
  `apps/web/src/auth.ts`:
  - After the user fetch + active check: if `lockedUntil > now()`,
    audit `auth.account.locked_attempt` and return null.
  - After the `verifyPassword` returns false: increment
    failedLoginCount, set lockedUntil = +1h if newCount >= 5,
    audit `auth.account.locked` on the lock-now branch, return null.
  - On success: replace the existing lastSeenAt UPDATE with one
    that also resets failedLoginCount and lockedUntil.

## T7. Unlock endpoint

- Create `apps/web/src/app/api/admin/users/[id]/unlock/route.ts`.
- POST handler: requireRole(["super_admin"]), UUID-shape validate
  the path id, 404 if user not found, otherwise UPDATE
  users.failedLoginCount=0, lockedUntil=NULL. Audit
  `auth.account.unlocked` with `unlockedBy: actor.id`.

## T8. UI link wiring

- Edit `apps/web/src/app/login/DesktopLogin.tsx` — change
  `<Link href="#">` to `<Link href="/login/forgot">`.
- Edit `apps/web/src/app/login/MobileLogin.tsx` — import `Link`
  from `next/link`, add a Link below the Sign-in button pointing
  at `/login/forgot`.

## T9. Spec-kit files

- spec.md (this directory)
- plan.md
- research.md
- quickstart.md
- tasks.md (this file)

## T10. Governance test

- Create `tests/governance/test_161_password_reset_and_account_lockout.test.mjs`.
- 12+ assertions covering the surface points above.
