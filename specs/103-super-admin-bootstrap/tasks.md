# Tasks 103

- [x] Add `bootstrapSuperAdmin(db)` to `packages/db/src/scripts/seed.ts` — env-gated, SELECT-then-INSERT idempotent, defence-in-depth `onConflictDoNothing`, bcrypt cost 10.
- [x] Add `bcryptjs ^2.4.3` + `@types/bcryptjs ^2.4.6` to `packages/db/package.json` mirroring `apps/web` versions.
- [x] Ship governance test `tests/governance/test_103_super_admin_bootstrap.test.mjs` with 5+ assertions and run `pnpm test -- tests/governance/test_103_*` green.
