# Plan 014

Files CREATED:
- `packages/db/src/schema/subjects.ts` — curriculum subjects table
- `apps/web/src/admin/entities/subjects.ts` — admin entity (replaces the v1 file that was renamed to `rtt-subjects.ts`)
- `packages/db/src/migrations/0002_*_sql` — drizzle-kit auto-generated CREATE TABLE
- `tests/governance/test_014_curriculum_subjects.test.mjs`

Files EDITED:
- `packages/db/src/schema/index.ts` — `export * from "./subjects";` (after rtt)
- `apps/web/src/admin/registry.ts` — add `subjectsEntity` (slug `subjects`)
