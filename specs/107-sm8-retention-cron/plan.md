# Plan 107

CREATED: `specs/107-sm8-retention-cron/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_107_sm8_retention_cron.test.mjs`
EDITED: `apps/worker/src/index.ts` (add retention Queue + Worker + nightly repeat job), `packages/db/src/scripts/retention.ts` (export `deleteOldNotifications()` + entry-point guard + fix `../src/schema/...` → `../schema/...` typo), `packages/db/src/index.ts` (re-export `deleteOldNotifications`)
MIGRATED: none
