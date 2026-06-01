# Plan 103

CREATED: `specs/103-super-admin-bootstrap/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_103_super_admin_bootstrap.test.mjs`
EDITED: `packages/db/src/scripts/seed.ts` (added `bootstrapSuperAdmin(db)` helper called first in `main()`, env-gated, idempotent via SELECT-then-INSERT plus defence-in-depth `onConflictDoNothing` on `users.email`), `packages/db/package.json` (added `bcryptjs ^2.4.3` + `@types/bcryptjs ^2.4.6` to mirror `apps/web` versions)
MIGRATED: none (uses existing `users` table from spec 004 schema; bcrypt cost 10 matches `apps/web/src/lib/password.ts`)
