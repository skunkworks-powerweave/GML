# Plan 003 — Superpowers Integration Test

**Spec:** specs/003-superpowers-integration-test/spec.md

## Implementation Blueprint

### Phase 2 — Foundational

Files CREATED:
- [P] `packages/shared/src/api-contracts/ping.ts` — zod schema for the response
- [P] `packages/shared/package.json` — add `zod` dep + `exports` map
- [P] `apps/web/src/app/api/ping/route.ts` — Next.js App Router GET handler

### Phase 3 — Integration

Files MODIFIED:
- `apps/web/package.json` — add `@gml/shared: "workspace:*"` dep

### Phase 4 — Test coverage

Files CREATED:
- `tests/governance/test_003_superpowers_integration.test.mjs` — assert route file exists, exports GET, references the shared contract

### Phase 5 — Commit

After tests green: `git add -A && git commit -m "feat(api): /api/ping endpoint + shared zod contract (spec 003)"`

## Superpowers lifecycle application (this spec exists to prove it)

| Step | Skill | What it did here |
|------|-------|------------------|
| 1. Brainstorm | `superpowers:brainstorming` | "What's the smallest endpoint that proves the harness?" → `/api/ping` returning `pong:true,ts`. Constraints: must use shared package so we exercise workspace deps; must have a zod contract so we exercise schema/validation pattern. |
| 2. Writing plans | `superpowers:writing-plans` | This spec's 5 files. |
| 3. TDD | `superpowers:test-driven-development` | Red: governance test fails on missing route file + missing contract module. Green: implement → tests pass. |
| 4. Verification | `superpowers:verification-before-completion` | `pnpm test` shows 23/23 pass; `curl` smoke against `pnpm dev` returns expected JSON. |
| 5. Code review | `superpowers:requesting-code-review` | Self-review checklist below applied; on real feature specs `feature-dev:code-reviewer` agent dispatched. |
| 6. Finishing | `superpowers:finishing-a-development-branch` | Commit message follows conventional commits; ledger entry appended; state.json advances. |
