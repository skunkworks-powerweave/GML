# Tasks 148

- [x] Read `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` and locate the INSERT + DELETE pair at lines 124-141.
- [x] Verify the `db.transaction` pattern in use elsewhere (`apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts:120` and forms / mentorship action files) so the spec-148 shape matches established convention.
- [x] Wrap the INSERT new `section_gates` row + DELETE old `section_gate_grants` rows in `db.transaction(async (tx) => { ... })`. Use `tx` (not `db`) for both writes.
- [x] Preserve the `.returning({ id: sectionGateGrants.id })` on the DELETE so the audit's `grantsInvalidated` count still works.
- [x] Return the deleted-id array from the transaction callback and bind it to `const deleted = await db.transaction(...)` so the existing audit reference (`deleted.length`) is unchanged.
- [x] Confirm `void recordAudit({...})` remains AFTER the closing brace of the `db.transaction(async (tx) => {...})` block.
- [x] Update the route's leading comment block with a spec-148 paragraph explaining the race window and the transaction wrapping.
- [x] Update the inline comment at the INSERT site to reference spec 148 and the SM-2 containment goal.
- [x] Write `tests/governance/test_148_gate_rotate_transaction.test.mjs` with 5+ assertions: file existence, `db.transaction(async (tx) =>` present, `tx.insert(sectionGates` present, `tx.delete(sectionGateGrants` present, audit fires AFTER transaction, all five spec-kit files exist.
- [x] Write all five spec-kit files in `specs/148-gate-rotate-transaction/` (spec, plan, research, quickstart, tasks).
- [x] Run the governance test and confirm it passes.
- [x] Confirm no new dependencies were added to `package.json`.
- [x] Confirm no migration was authored (next migration idx 0016 stays available for the next schema-touching Run 13 spec).
