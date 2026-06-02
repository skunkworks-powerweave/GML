# Spec 161 — Quickstart

## Run the migration

```bash
pnpm --filter @gml/db drizzle migrate
```

(or whatever the existing migrate command is — drizzle-kit picks up
the new 0020_password_reset_and_lockout.sql automatically from the
journal).

## Exercise the forgot-password flow locally

1. With SMTP unwired (the default for `pnpm dev`):

   ```bash
   curl -X POST http://localhost:3000/api/auth/forgot-password \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@goldenmilelearning.org"}'
   ```

   Response should be `200 {"ok":true}` even if the email doesn't
   resolve to a user. Check the `audit_log` table for an
   `auth.password.reset_requested` row.

   ```sql
   SELECT action, metadata, created_at FROM audit_log
   WHERE action LIKE 'auth.password.%' ORDER BY created_at DESC LIMIT 5;
   ```

2. If a row was inserted in `password_reset_tokens`, copy the
   plaintext token from your terminal (the handler prints it to
   the email body — without SMTP wired you can read it from the
   audit log's `tokenId` field by cross-referencing the row).

   In dev, the easier path is to peek at the row directly:

   ```sql
   SELECT id, expires_at FROM password_reset_tokens
   ORDER BY created_at DESC LIMIT 1;
   ```

   The plaintext token itself is NOT in the DB (only the bcrypt
   hash). In dev you can simulate the email-link path by issuing
   a known token through a helper script.

## Exercise account lockout

1. Trigger 5 failed credentials logins from the UI (or via curl
   against `/api/auth/signin/credentials` with a wrong password).
2. Check `users.failed_login_count` and `users.locked_until`:

   ```sql
   SELECT email, failed_login_count, locked_until FROM users
   WHERE email = 'teacher1@example.com';
   ```

3. Attempt a 6th login (even with the correct password) — should
   fail. Audit log should show `auth.account.locked_attempt`.

4. As a super_admin, clear the lockout:

   ```bash
   curl -X POST http://localhost:3000/api/admin/users/<id>/unlock \
     -b 'authjs.session-token=<your-session-cookie>'
   ```

5. Confirm `failed_login_count = 0` and `locked_until IS NULL`.

## Run the governance test

```bash
node --test tests/governance/test_161_password_reset_and_account_lockout.test.mjs
```

Expected output: 12+ assertions pass.
