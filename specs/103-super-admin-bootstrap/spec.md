# Spec 103 — Super admin bootstrap in seed script

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening — Workflow Run 6 Tier B1)

## Overview

A fresh GML LMS deployment had no super_admin user. The seed script (`packages/db/src/scripts/seed.ts`) seeded districts, zones, schools, teachers, mentors, pairings, cycles, RTT phases, terms, subjects, and curricular subjects — but never inserted a single row into `users`. Operators following README-IT discovered this on first login: any newly-created account defaulted to `role = "teacher"` (the enum default in `packages/db/src/schema/identity.ts`), the RBAC middleware (spec 007) sent them to `/forbidden`, and the documented "recovery" was a manual `UPDATE users SET role = 'super_admin' WHERE email = ?;` SQL statement run by SSH'ing into Postgres. That works once, by an operator who knows SQL, on a known database — and falls over the moment a self-hosting deployer tries to follow the README cleanly.

This spec extends the existing seed script with a final "Super admin bootstrap" block that reads `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_INITIAL_PASSWORD` from environment variables, bcrypt-hashes the password with cost 10 (the same cost used by `apps/web/src/lib/password.ts` from spec 005), and inserts a single row into `users` with `role = "super_admin"`, `default_locale = "en"`, `name = "Super Admin"`, and `active = true`. The block is fully idempotent: it skips silently when the env vars are missing (so CI test seeds and ephemeral dev databases don't fail), it does a `SELECT … WHERE email = ?` existence check before bcrypt'ing (so re-running `pnpm seed` after a successful run doesn't waste a CPU-heavy hash op or log a confusing warning), and it stacks a defence-in-depth `.onConflictDoNothing({ target: users.email })` on the unique email constraint so even a race-condition double-call lands cleanly.

The block runs as the very first thing inside `main()` — before the existing `districts` early-return guard — because the super_admin bootstrap is logically independent of the Ladakh seed data. An operator with an existing populated DB (districts already seeded) can still bootstrap a missing super_admin by re-running `pnpm seed` with the env vars set. This decouples the two concerns and matches the operator's mental model: "run the seed script, get a working admin user, regardless of whether the dataset is fresh."

## Functional Requirements

- **FR-001** — `packages/db/src/scripts/seed.ts` imports `bcrypt` from `bcryptjs` at the top of the file.
- **FR-002** — `packages/db/package.json` declares `bcryptjs` in `dependencies` and `@types/bcryptjs` in `devDependencies`, matching the versions already used in `apps/web/package.json` (^2.4.3 and ^2.4.6 respectively).
- **FR-003** — `seed.ts` defines an `async function bootstrapSuperAdmin(db)` that takes the drizzle `db` handle and returns `Promise<void>`.
- **FR-004** — `bootstrapSuperAdmin` reads `process.env.SUPER_ADMIN_EMAIL` and `process.env.SUPER_ADMIN_INITIAL_PASSWORD`. If either is missing, the function logs `"[seed] super_admin bootstrap skipped — SUPER_ADMIN_EMAIL not set"` and returns. (The log line names only the email var to keep the message scannable; the password var is implied by the function's contract.)
- **FR-005** — `bootstrapSuperAdmin` executes `SELECT id FROM users WHERE email = ? LIMIT 1` against the drizzle `users` table using `eq` from `drizzle-orm`. If any row is returned, the function logs `"[seed] exists — skipping super_admin bootstrap for <email>"` and returns. The existence check uses the canonical `email` column (unique-indexed per spec 004) so we benefit from the index even without an explicit hint.
- **FR-006** — On the happy path, `bootstrapSuperAdmin` calls `bcrypt.hash(password, 10)` to produce the password hash. Cost 10 matches the constant in `apps/web/src/lib/password.ts` so admin logins go through the exact same verify path with no special-casing.
- **FR-007** — `bootstrapSuperAdmin` performs `db.insert(schema.users).values({ email, passwordHash, role: "super_admin", defaultLocale: "en", name: "Super Admin", active: true }).onConflictDoNothing({ target: schema.users.email })`. The `onConflictDoNothing` is defence-in-depth — the existence check should have caught the duplicate — but two concurrent seeds (one in CI, one in deploy, sharing a DB) is theoretically possible and the conflict clause keeps both happy.
- **FR-008** — On successful insert the function logs `"[seed] ✓ super_admin user created: <email>"` so the deployment script's stdout makes the bootstrap visible to the operator.
- **FR-009** — `main()` calls `await bootstrapSuperAdmin(db)` AFTER the pool/db handle is constructed but BEFORE the `SELECT COUNT(*) FROM districts` early-return guard. This means: a re-run on a populated DB still attempts the super_admin bootstrap, and the existing district-count check still short-circuits the Ladakh seed insert work as it did before this spec.
- **FR-010** — The bootstrap block does NOT add to the existing `[seed] DONE` summary line at the end of the script. The summary still describes only the Ladakh seed (districts, zones, schools, etc) — the super_admin event has its own dedicated log line (`✓ super_admin user created: ...`) which is easier to grep and is the conventional pattern across the other seed scripts (`seed_forms_observation.ts`, `seed_forms_mentor.ts`, etc).

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| Fresh DB + both env vars set | `pnpm seed` prints `✓ super_admin user created: ...`, then proceeds to insert Ladakh seed. `SELECT role FROM users WHERE email = ?;` returns `super_admin`. |
| Fresh DB + env vars NOT set | `pnpm seed` prints `super_admin bootstrap skipped — SUPER_ADMIN_EMAIL not set`, then proceeds to insert Ladakh seed. `SELECT COUNT(*) FROM users;` returns `0`. |
| Populated DB (districts exist) + env vars set + super_admin user does NOT exist | Bootstrap runs and inserts the super_admin row; Ladakh seed is skipped via the districts-count guard (unchanged). |
| Populated DB + env vars set + super_admin user already exists | Bootstrap logs `exists — skipping super_admin bootstrap for ...`; no row is inserted; existing password hash is preserved. |
| Re-running `pnpm seed` twice with the same env vars | Second run logs `exists — skipping`; row count in `users` stays at 1. (Idempotency.) |
| Env vars set but password is empty string | Treated as missing — skip path (an empty password is never a valid bootstrap). |
| Concurrent seeds racing on the same email | `onConflictDoNothing` ensures only one row lands; both invocations succeed without raising. |
| Login flow with seeded credentials | Operator can log in at `/login` with the env-supplied email + password; lands at `/dashboard` (no `/forbidden` redirect). |

## Audit hooks (SM-9)

None — the seed script is an offline boot-up tool that runs before any session exists. The standard `audit_log.user.created` row that the admin user-creation API (spec 064) writes is intentionally NOT emitted here, because the bootstrap is conceptually "ground truth state" not a user action; there is no actor to attribute the event to. Operators who want the row can re-create the user via the admin UI once they've logged in.

## Out of scope

- Triggering a forced password rotation on first login. The README-IT instructs the operator to use `SUPER_ADMIN_INITIAL_PASSWORD` as an interim secret and immediately rotate it through `/profile/password` (spec 035) after the first login. Coupling the rotation into the seed is more friction than value.
- Seeding multiple super_admin users from a list. A single bootstrap user is enough to "get to the admin UI", and the admin UI is the right place to create additional super_admins (with audit trail).
- Generating the password if the env var is missing. We deliberately skip silently rather than auto-generate — auto-generated passwords logged to stdout get pasted into chat logs, screenshots, and tickets, which is exactly how supply-chain credentials leak.
- Hashing with argon2 or scrypt. bcrypt at cost 10 is what the rest of the auth pipeline uses (spec 005); deviating in the seed would force a special-case in the login path.

## Design deviations

None. The block follows the existing `seed.ts` idiom (SELECT-then-INSERT for idempotency, plus defence-in-depth `onConflictDoNothing` matching the pattern in `seed_forms_observation.ts`).
