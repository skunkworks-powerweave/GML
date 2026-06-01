# Plan 015

CREATED:
- `packages/db/src/schema/classes.ts`
- `apps/web/src/admin/entities/classes.ts`
- `packages/db/src/migrations/0003_classes.sql` (drizzle-kit auto + descriptive rename)
- `tests/governance/test_015_classes.test.mjs`

EDITED:
- `packages/db/src/schema/index.ts` — barrel
- `apps/web/src/admin/registry.ts` — append `classes: classesEntity`
