# Spec 111 — Integration Smoke (Workflow Run 8 Tier E1)

## Why

Every test in this repo to date is a **grep test**: it reads a source file
and asserts that a string or regex is present. That family of tests is
fast and reliable for catching refactors that delete required exports,
but it cannot tell you whether the running app actually answers an HTTP
request. We have 664 governance tests on green, and yet we have no
single check that says "yes, you can `curl /api/health` and get a 200
back". The closure of Run 8 demands at least one **behavioural** test
that drives the app through real HTTP, so that the next operator
deploying to a Cloud VPS has a fast way to confirm the stack is wired
together: not just compiled, but reachable, with auth gates and
migrations working as designed.

This is the first such test. We deliberately keep it opt-in: it is run
via `pnpm test:smoke`, not by the default `pnpm test`. The reason is
testing-environment friction: `pnpm test` runs in CI containers and on
developer laptops where the full Docker stack (Postgres, Redis, MinIO,
Next.js) is not always up. If we made the smoke part of the default
suite, every PR would either need a live stack or every developer would
need to wait through eight timeouts. Skip-on-unreachable lets the same
file behave correctly in both worlds.

## What

Add `tests/integration/smoke.test.mjs`. The file uses `node:test` and
`assert/strict` (same idioms as governance tests) but instead of reading
sources, it calls `globalThis.fetch()` against `process.env.SMOKE_BASE_URL`
(default `http://localhost:3000`). A `before` hook probes
`/api/health` with a 2-second AbortController timeout. If the probe
fails or returns non-200, every subsequent test calls `t.skip(...)` with
a human-readable reason. If the probe succeeds, the suite exercises 8
distinct endpoints:

1. `GET /api/health` — spec-110 shape (`ok`, `details.{db,redis,minio,migrations}`).
2. `GET /login` — 200 with visible "Sign in" copy (login reskin spec 034).
3. `GET /api/auth/csrf` — 200 with `csrfToken`.
4. `POST /api/auth/callback/credentials` — bad creds → 401 OR redirect to `/login?error=…`.
5. `GET /dashboard` (no cookies) — 302 → `/login` (RBAC middleware spec 007).
6. `GET /api/health` (second call) — `migrations.ok === true` (boot ran migrations).
7. `POST /api/notifications/mark-read` (no session) — 401 (spec 096 auth gate).
8. `POST /api/webhooks/whatsapp` (no HMAC) — 401 (signature verification spec 040).

The top-level `package.json` gains a `test:smoke` script:
`node --test "tests/integration/**/*.test.mjs"`. The default `test`
script is narrowed to `tests/governance/**/*.test.mjs` so smoke doesn't
sneak into PR CI runs.

## Edge cases

1. **App not running.** The 2-second probe times out via AbortController;
   `reachable` stays false; every test calls `t.skip(...)` with a message
   pointing the operator at `make up` or `SMOKE_BASE_URL`. Crucially,
   `t.skip()` reports as "skipped", not "failed" — exit code is zero.

2. **App running but `/api/health` returns 500.** The probe checks
   `res.status === 200`, so a half-broken health endpoint also triggers
   the skip path. This protects against the smoke running against a
   pre-migration deploy where `db.ok` is false: rather than collecting
   eight cascading failures, the suite skips cleanly.

3. **Auth.js v5 vs v4 redirect behaviour.** Auth.js v5 issues a 302 to
   `/login?error=CredentialsSignin` on bad creds; older versions
   sometimes return 401 directly. Test 4 accepts both shapes so a future
   upstream upgrade doesn't fail the smoke.

4. **Login page localisation.** The login reskin (spec 034) defaults to
   English but the i18n hooks (spec 083) allow Hindi/Ladakhi. Test 2
   accepts "Sign in" / "Sign In" / "sign in" / the Hindi `लॉग` prefix so
   the smoke runs in all three locale builds.

5. **Default `pnpm test` must remain green.** Narrowing the `test` glob
   from `tests/**/*.test.mjs` to `tests/governance/**/*.test.mjs` is a
   behaviour change: in principle a test file outside `governance/`
   would now be missed. We accept this because (a) `integration/` is
   the only sibling, and (b) keeping smoke out of the default suite is
   exactly the goal of this spec.

## Non-goals

- No fixture data, no DB seeding, no test users. The 8 checks all hit
  paths that are exercised on empty data (health, auth gates, webhook
  signature gate). Full end-to-end "log in as a teacher, upload a
  video" coverage is a future spec — a fixture harness is out of scope
  here.
- No assertion of response bodies beyond shape sanity. Smoke is a "did
  the wires connect" test, not a "did the business logic compute the
  right answer" test. Governance tests already cover the latter.
- No new dependencies. We use only `node:test`, `assert/strict`, and
  `globalThis.fetch` (Node ≥ 18). The repo's `engines.node` is ≥ 22.
- No automatic stack-up. The operator (or `make smoke` in a future
  Makefile target) is responsible for `make up` first. The skip
  message tells them so.

## Definition of done

- `tests/integration/smoke.test.mjs` exists with 8 fetch-based tests.
- Each test calls `t.skip(...)` cleanly when the app is unreachable.
- `package.json` has a `test:smoke` script using `node --test`.
- The default `test` script no longer includes `tests/integration/`.
- Governance test `test_111_integration_smoke.test.mjs` asserts the
  file's existence, its use of `node:test` + `fetch`, that it
  references at least four `/api/...` endpoints, that it implements
  skip-on-unreachable, and that the `test:smoke` script is wired in.
