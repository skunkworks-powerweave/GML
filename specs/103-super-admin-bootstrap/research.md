# Research 103

- `users` table (spec 004, `packages/db/src/schema/identity.ts`) already has a unique index on `email` and a `role` column defaulting to `"teacher"` via `roleEnum` (spec 004 `enums.ts`) — `super_admin` is the highest tier of the 5-role hierarchy.
- `apps/web/src/lib/password.ts` (spec 005) uses `bcryptjs` with `COST = 10`; matching here keeps the verify path uniform and lets the seeded user log in through the existing Credentials provider without special-casing.
- `seed_forms_observation.ts` already demonstrates the `onConflictDoNothing({ target: ... })` pattern on a unique constraint as a defence-in-depth idempotency mechanism — re-used here so concurrent seed invocations don't fail.
