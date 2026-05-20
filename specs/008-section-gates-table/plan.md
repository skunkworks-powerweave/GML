# Plan 008

Files CREATED:
- `packages/db/src/schema/gates.ts`
- `apps/web/src/lib/gates.ts`
- `tests/governance/test_008_section_gates_table.test.mjs`

Files EDITED:
- `packages/db/src/schema/index.ts` — export gates
- `apps/web/src/middleware.ts` — add `gatedPrefixes` policy + getActiveGrant lookup (still JWT-light; full DB query lands in spec 010 with the audit context).
