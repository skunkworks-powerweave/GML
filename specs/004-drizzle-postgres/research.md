# Research 004

## D-001: Drizzle over Prisma

Drizzle keeps schema as code (TypeScript), produces plain SQL migrations the IT team can read, has zero runtime engine overhead, and works with `pg`. Prisma's schema DSL + generated client adds a build step + a binary. Drizzle wins for this stack.

## D-002: `pg` (node-postgres) over `postgres.js`

`pg` is older, broader compat, and ships the connection pool we need. `postgres.js` is more performant but less integrated with auth-js adapter expectations.

## D-003: Auth.js v5 Drizzle adapter schema shape

Tables: `users`, `accounts`, `sessions`, `verificationTokens` — column names must match what `@auth/drizzle-adapter` expects (camelCase keys, snake_case columns are fine since Drizzle handles the mapping). Source: https://authjs.dev/getting-started/adapters/drizzle.

## D-004: Migrations are tracked SQL, not just Drizzle metadata

`drizzle-kit generate` writes both `.sql` and `meta/` snapshots. We commit both. The boot-time migrator reads `meta/` to know what to apply.

## D-005: `roleEnum` as pg ENUM, not TEXT + CHECK

ENUM is faster, indexable, and the canonical way in Postgres. Drizzle's `pgEnum` produces clean migration SQL.
