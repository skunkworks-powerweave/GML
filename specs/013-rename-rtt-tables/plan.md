# Plan 013

Files EDITED:
- `packages/db/src/schema/rtt.ts` — rename all 6 Drizzle exports + their `pgTable("…")` names
- `packages/db/src/schema/index.ts` — barrel re-exports update transparently (already `export *`)
- `apps/web/src/admin/entities/attendance.ts` → renamed `rtt-attendance.ts`; import `rttAttendance`
- `apps/web/src/admin/entities/subjects.ts` → renamed `rtt-subjects.ts`; import `rttSubjects`; slug stays `subjects` until spec 014 takes it
- `apps/web/src/admin/registry.ts` — update entity imports + slugs

Files CREATED:
- `packages/db/src/migrations/0001_rename_rtt_tables.sql` — manual ALTER TABLE RENAME statements (drizzle-kit's non-interactive mode would emit DROP+CREATE; hand-write the rename)
- `packages/db/src/migrations/meta/0001_snapshot.json` — regenerated via drizzle-kit (will use the new schema state) OR copy from 0000 and rewrite table-name keys
- `tests/governance/test_013_rename_rtt_tables.test.mjs`

Files MODIFIED:
- `packages/db/src/migrations/meta/_journal.json` — append the 0001 entry
