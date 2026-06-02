# Spec 161 — Password reset and account lockout (Workflow Run 15 audit closure, MISS)

## Why

The 7-agent codebase audit at the close of Workflow Run 14 flagged two
adjacent feature gaps in the credentials authentication path. Neither is
in isolation a CVSS-9 hole — the LMS is internal-use-only behind a
small mentor + admin population — but they compound:

1. **No password reset flow.** A teacher who forgot their password had
   no self-service path. The only recovery was for a super_admin to
   open a Postgres shell, manually bcrypt-hash a new password, and
   `UPDATE users SET password_hash = '...' WHERE email = '...'`. That
   is operationally brittle: the super_admin has to hold the bcrypt
   knowledge in their head, AND every reset is invisible to the audit
   log (the DB-level write doesn't fire the application-level
   recordAudit). Operators were unable to answer the post-incident
   question "did Mentor X ever reset their password, and from what IP."

2. **No account lockout after repeated failures.** The credentials
   authorize() callback (added in spec 005, hardened by spec 141)
   rate-limits at 5 attempts per 15 minutes per (ip, email). That
   stops a single-IP burst, but an attacker who controls a small
   botnet (or who simply waits out the 15-minute window) can grind
   through password guesses indefinitely. Worse: every attempt burns
   server-side bcrypt CPU regardless of how many times it's failed,
   so a tar-pit-style attack against the credentials endpoint can
   degrade login latency for everyone else. The audit response
   recommended a 1-hour lockout after 5 consecutive misses, with a
   super_admin-only unlock path for early recovery.

## What we ship

### Schema (migration 0020)

A new `password_reset_tokens` table holds the ledger of every reset
request. Tokens are 32 random bytes hex-encoded (64 chars) handed to
the user via email; the row stores a bcrypt(cost=10) hash, never the
plaintext. `expiresAt = now() + 30 min` (per spec contract). The
`requestedFromIp` column holds the MASKED IP (last octet stripped,
same shape as `audit.ip`) so a DB leak doesn't expose per-account IP
history.

`users` gains two columns:

- `failed_login_count int NOT NULL DEFAULT 0` — consecutive bad-cred
  hits. Resets to 0 on every successful login.
- `locked_until timestamptz NULL` — when set in the future, blocks
  the bcrypt verify path entirely. The authorize() callback short-
  circuits with an `auth.account.locked_attempt` audit row.

### Forgot-password flow

- New page `/login/forgot` — email input + Submit. POSTs JSON to
  `/api/auth/forgot-password`.
- `/api/auth/forgot-password` (POST):
  - Rate-limit 3/hr per IP (bucket = `forgot-password`). Fail-CLOSED
    on Redis down, per spec 141's pattern.
  - `crypto.randomBytes(32).toString("hex")` plaintext, `bcrypt.hash`
    at cost 10, store the hash.
  - Always respond 200 (NO ENUMERATION). The audit row carries
    `matched: false` when the email doesn't resolve, so operators
    still see attempted resets.
  - If `SMTP_HOST` is configured, send the reset link via Nodemailer.
    The link is `${APP_URL}/login/reset?token=<plaintext>`.
- New page `/login/reset?token=...` — prompts for new password, POSTs
  to `/api/auth/reset-password`.
- `/api/auth/reset-password` (POST):
  - Loop through unconsumed-non-expired tokens, bcrypt-compare each
    against the plaintext.
  - On match: bcrypt-hash the new password, `db.transaction` updates
    `users.passwordHash` + sets `consumedAt = now()` + clears the
    lockout counters. Audit `auth.password.reset_completed`.
  - Failure modes return 410 (one code for "token not found / expired
    / already consumed" so a probing attacker can't distinguish).
- The desktop `/login` page's "Forgot password?" link, previously a
  stub `<a href="#">`, now routes to `/login/forgot`. The mobile shell
  gains a parallel "Forgot password?" link below the Sign-in button.

### Account lockout

- `auth.ts` authorize() callback:
  - Before bcrypt verify, check `user.lockedUntil > now()`. If so,
    return null + audit `auth.account.locked_attempt`.
  - On bcrypt mismatch, increment `users.failedLoginCount`. If the
    new count is ≥5, set `lockedUntil = now() + 1h` and audit
    `auth.account.locked`.
  - On successful login, fold a counter reset into the existing
    `lastSeenAt` UPDATE: `failedLoginCount = 0, lockedUntil = NULL`.
- New `/api/admin/users/[id]/unlock` (POST), super_admin-only,
  clears both columns and audits `auth.account.unlocked` with the
  actor's user id.

## Acceptance criteria

- `packages/db/src/schema/identity.ts` exports `passwordResetTokens`
  and the `users` table declares `failedLoginCount` + `lockedUntil`.
- Migration 0020 ships the CREATE TABLE + ALTER TABLE + indexes.
- `apps/web/src/app/api/auth/forgot-password/route.ts` exists and
  contains a POST handler.
- `apps/web/src/app/api/auth/reset-password/route.ts` exists and
  contains a POST handler.
- `apps/web/src/app/login/forgot/page.tsx` and
  `apps/web/src/app/login/reset/page.tsx` render the forms.
- `apps/web/src/app/api/admin/users/[id]/unlock/route.ts` exists,
  guards super_admin only.
- `apps/web/src/auth.ts` contains the locked-until check, the
  failedLoginCount-increment-and-maybe-lock branch, the success-path
  reset, AND emits the three audit actions
  (`auth.account.locked_attempt`, `auth.account.locked`,
  `auth.password.reset_*`).
- DesktopLogin's "Forgot password" link points at `/login/forgot`,
  not `#`.
- All five spec-kit files exist under
  `specs/161-password-reset-and-account-lockout/`.
- The governance test passes with ≥12 assertions.

## Non-goals

- **No password strength meter, no breach-database check.** The form
  enforces an 8-character minimum (matches the rest of the codebase);
  anything more ambitious is a separate spec.
- **No CAPTCHA on /login/forgot.** Rate-limit 3/hr per IP is the
  contract; a CAPTCHA would force browser JS in environments where
  the credentials form intentionally doesn't.
- **No automatic email send on lockout.** The lockout audit row is
  the operator's signal; ringing the alarm in the user's inbox would
  give the attacker a confirmation that they were targeting a real
  account.
- **No per-IP failed-attempt counter.** The lockout is per-user-row
  because that's the surface the bcrypt CPU budget protects. The
  per-(ip,email) rate-limit (5/15min, spec 141) is already in place
  for the IP dimension.
