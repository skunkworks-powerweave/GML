# Plan 011

Files CREATED:
- `tests/governance/test_011_substrate_moats.test.mjs` — SM-1, SM-2, SM-4 enforcement
- `packages/db/src/migrations/_post/001_revoke_audit_writes.sql` — raw SQL for SM-1 layer 1
- `scripts/check-restore-drill.mjs` — SM-5 check
- `docs/substrate-moats.md` — replace placeholder with real content + enforcement matrix

Files EDITED:
- `packages/db/scripts/migrate.ts` — apply `_post/*.sql` after the drizzle-kit migrations
- `lms-app/README-IT.md` — add the SM-4 deterrence sentence
