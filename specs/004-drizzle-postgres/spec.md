# Spec 004 — Drizzle Postgres

**Status:** in_progress
**Date:** 2026-05-20
**Constitution Check:** Touches `audit_log` foundation (SM-1 append-only) — enforcement lands in spec 010 + 011, but the table shape here must not block it.

## Overview

Stand up the `@gml/db` package with Drizzle ORM targeting Postgres 16, the connection helper, the migration runner, and the **identity tables** (users, accounts, sessions, verification_tokens — Auth.js v5 schema shape). Other tables (geography, observation, video, mentorship, audit) land in their feature specs.

## User Stories

**US1 (Developer — query users):**
As the developer, I can `import { db, users } from "@gml/db"; await db.select().from(users);` and get a typesafe result.
**Independent Test:** `pnpm --filter @gml/db typecheck` passes; `db.select().from(users)` returns the typed `User[]` shape in IDE hover.

**US2 (Developer — schema is migratable):**
As the developer, running `pnpm --filter @gml/db generate` produces SQL migration files in `packages/db/src/migrations/`. Running `pnpm --filter @gml/db migrate` applies them against the Postgres in `docker compose`.
**Independent Test:** `pnpm --filter @gml/db generate` exits 0 and writes `0000_*.sql`. (Apply step deferred — requires postgres running.)

**US3 (Substrate-moat-1 compatible):**
The `audit_log` placeholder NOT yet shipped here but reserved — schema for it lands in spec 010. The identity tables must NOT introduce any column or constraint that would later block SM-1's append-only enforcement.

## Functional Requirements

- **FR-001**: `packages/db/package.json` declares deps: `drizzle-orm`, `drizzle-kit` (dev), `pg`, `@types/pg` (dev). Plus `dotenv` (dev).
- **FR-002**: `packages/db/src/index.ts` exports `db` (Drizzle client) and all table objects.
- **FR-003**: `packages/db/src/client.ts` — creates a `pg.Pool` from `DATABASE_URL`, wraps in `drizzle()`.
- **FR-004**: `packages/db/src/schema/identity.ts` — `users`, `accounts`, `sessions`, `verificationTokens` per Auth.js Drizzle adapter spec.
- **FR-005**: `packages/db/src/schema/enums.ts` — `roleEnum` with `super_admin | programme_admin | mentor | observer | teacher`.
- **FR-006**: `packages/db/drizzle.config.ts` — points at the schema, sets dialect: 'postgresql', outputs to `src/migrations/`.
- **FR-007**: `packages/db/scripts/migrate.ts` — runs `migrate()` from drizzle-orm/node-postgres/migrator against `DATABASE_URL`. Called by the app container on boot.

## Independent Test

```powershell
pnpm install
pnpm --filter @gml/db generate         # produces 0000_*.sql
ls packages/db/src/migrations          # should show .sql + meta/
pnpm test                              # all governance tests still green
```

## Out of scope
- Auth.js wiring → spec 005
- All non-identity tables → later specs
- Migration apply against real Postgres → spec 002 runtime test or 005 (when first auth flow needs real persistence)
