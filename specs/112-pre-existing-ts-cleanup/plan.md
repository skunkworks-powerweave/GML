# Plan 112

CREATED: `specs/112-pre-existing-ts-cleanup/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_112_pre_existing_ts_cleanup.test.mjs`
EDITED: `packages/db/src/scripts/seed.ts` (TS2488 fix — access `.rows[0]` on the pg QueryResult returned by `db.execute()` instead of array-destructuring)
MIGRATED: none
