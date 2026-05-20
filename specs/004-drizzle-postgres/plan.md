# Plan 004 — Drizzle Postgres

**Spec:** specs/004-drizzle-postgres/spec.md

## Files CREATED

- `packages/db/package.json` (edited) — deps, scripts
- `packages/db/drizzle.config.ts`
- `packages/db/src/client.ts` — pg Pool + drizzle client
- `packages/db/src/index.ts` — barrel
- `packages/db/src/schema/enums.ts` — roleEnum
- `packages/db/src/schema/identity.ts` — users/accounts/sessions/verificationTokens (Auth.js v5 shape)
- `packages/db/src/schema/index.ts` — re-exports all schema modules
- `packages/db/scripts/migrate.ts` — boot-time migrator
- `tests/governance/test_004_drizzle_postgres.test.mjs`

## Discipline

- Brainstorming: chose Auth.js Drizzle adapter schema shape verbatim (forces compatibility with auth-js v5 in spec 005). Decided enums via `pgEnum` (vs check constraints) for IDE auto-complete.
- TDD: governance test asserts file shape + schema export presence.
- Verification: `pnpm --filter @gml/db generate` must exit 0.

## Substrate moats

- Reserve `audit_log` shape (column types, table-level grants) for spec 010 — no decisions here would block append-only enforcement.
