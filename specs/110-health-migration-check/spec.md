# Spec 110 — Health Migration Check (Workflow Run 7 Tier D4)

## Why

The deployment audit closing Run 7 surfaced a silent-failure class on
`/api/health`: the route reports `db.ok` true as soon as the Postgres
server accepts a `SELECT 1`, even if no Drizzle migrations have been
applied. An operator who deploys the stack without running
`pnpm --filter @gml/db run migrate` sees a green dashboard, then watches
the first user request 500 on a missing table. The corresponding 2 AM
Slack message reads "but health says we're up." We need the health
endpoint to fail loud when the schema isn't there — comparable to how
spec 102 makes MinIO buckets auto-init and spec 103 bootstraps the
super_admin: cover the foot-gun before it bites.

## What

Extend `apps/web/src/lib/health.ts` with a new exported `pingMigrations()`
function and wire it into `/api/health`. The function reads
`packages/db/src/migrations/meta/_journal.json` (the manifest Drizzle
generates alongside each migration file) to compute the **expected**
migration count, then queries Postgres for `SELECT count(*) FROM
drizzle.__drizzle_migrations` (the table Drizzle's `migrate()` helper
creates and populates) for the **applied** count. Returns
`{ ok, applied, expected, error? }` where `ok` is true iff
`applied >= expected`. We accept ≥ rather than === because in-flight
migration development (locally generated 0014, not yet bundled into a
release tag) shouldn't trip an alarm — only "schema lags the build"
should.

## Edge cases

1. **Drizzle table missing.** If `drizzle.__drizzle_migrations` doesn't
   exist (operator never ran migrate), the `SELECT` fails with Postgres
   error 42P01. We catch this, return `ok:false, applied:0, expected:N,
   error:'drizzle migrations table not found'`. The sentinel string lets
   the operator grep the JSON response and immediately understand the
   remediation ("run the migrate command") without reading code.

2. **Journal file missing.** If the build was assembled wrong and the
   journal isn't in the deployed image, we return `ok:false, applied:0,
   expected:0, error:'_journal.json not found'`. This is rare (CI would
   fail to build) but the failure mode is distinct from "migrations not
   applied" and the operator deserves to see which.

3. **POSTGRES_HOST unset.** Mirrors `pingDb`'s behaviour: short-circuit
   with `ok:false, error:'POSTGRES_HOST not set'`. No silent green when
   the env is broken.

4. **CWD ambiguity.** Next.js's `process.cwd()` is the repo root in
   `next dev` but `apps/web` in standalone builds. The function tries
   both candidate paths (`packages/db/...` and `../../packages/db/...`)
   so the same code works in dev, in Docker, and in CI.

5. **Connection failure.** If the Pool can't connect at all (vs.
   table-not-found), we return the underlying error message verbatim.
   The operator can distinguish "DB down" from "schema not migrated"
   from the message.

## Route changes

`apps/web/src/app/api/health/route.ts` adds `pingMigrations()` to the
`Promise.all`, includes `migrations: migrations.ok` in the top-level
JSON, includes the full `migrations` object in `details`, and changes
the overall `ok` flag from the stub `true` to the conjunction `db.ok &&
redis.ok && minio.ok && migrations.ok`. The route still always responds
200 — health endpoints conventionally use status codes for
infrastructure liveness (the route ran), not application readiness (the
flag inside the body). Monitors should alert on `ok:false`, not on a
non-200.

## Non-goals

- No new health dependencies. The function uses only `pg` (already a
  workspace dep), `node:fs`, `node:path`, all built-in.
- No retries. A single failed query is enough — health checks run
  frequently and transient failures recover on the next poll.
- No schema introspection beyond the migrations table. We don't try
  to verify "do the expected tables exist" — that's the migrations
  table's job and re-checking it would duplicate Drizzle's contract.
- No alerting integration. The operator monitor (or
  `tools/monitor/healthcheck.mjs` in future work) consumes the JSON.

## Definition of done

- `pingMigrations()` is exported from `apps/web/src/lib/health.ts`.
- The function reads `_journal.json` and counts `entries` for expected.
- The function queries `drizzle.__drizzle_migrations` for applied.
- Table-not-found returns the sentinel `error` string verbatim.
- `/api/health` includes `migrations` in the response.
- Overall `ok` reflects all four sub-systems.
- Governance test `test_110_health_migration_check.test.mjs` asserts
  the exports, the journal reference, the Drizzle table query, the
  Promise.all wiring, and the ok-flag conjunction.
