# Plan 148

CREATED: `tests/governance/test_148_gate_rotate_transaction.test.mjs`, `specs/148-gate-rotate-transaction/{spec,plan,research,quickstart,tasks}.md`
EDITED: `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` (wrap INSERT + DELETE in `db.transaction(async (tx) => { ... })`, keep `recordAudit` after the transaction await returns, add a spec-148 paragraph to the route header documenting the race-window closure)
MIGRATED: none — pure transaction-boundary fix on existing schema; the row shapes for `section_gates` and `section_gate_grants` are unchanged and no migration index is consumed (next migration idx 0016 stays available for the next schema-touching spec in Run 13)
