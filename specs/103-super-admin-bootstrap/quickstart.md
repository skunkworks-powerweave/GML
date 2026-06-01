# Quickstart 103

1. Set `SUPER_ADMIN_EMAIL=admin@example.org` and `SUPER_ADMIN_INITIAL_PASSWORD=<temp-secret>` in `.env`, then run `pnpm --filter @gml/db exec tsx src/scripts/seed.ts` — expect log line `[seed] ✓ super_admin user created: admin@example.org`.
2. Verify the row: `psql $DATABASE_URL -c "SELECT email, role FROM users WHERE email = 'admin@example.org';"` — expect one row with `role = 'super_admin'`.
3. Re-run the seed command — expect `[seed] exists — skipping super_admin bootstrap for admin@example.org` (idempotency); log into `/login` with the credentials and confirm you land at `/dashboard` (not `/forbidden`).
