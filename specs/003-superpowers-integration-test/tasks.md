# Tasks 003

- [ ] T1 Write `tests/governance/test_003_*.test.mjs` (red)
- [ ] T2 Create `packages/shared/src/api-contracts/ping.ts` (zod schema)
- [ ] T3 Update `packages/shared/package.json` — `zod` dep + `exports` map
- [ ] T4 Update `apps/web/package.json` — add `@gml/shared: workspace:*`
- [ ] T5 Create `apps/web/src/app/api/ping/route.ts`
- [ ] T6 `pnpm install` (resolves workspace link)
- [ ] T7 Green phase: re-run `pnpm test` → 23/23 pass
- [ ] T8 Commit + ledger entry + state.json advance
