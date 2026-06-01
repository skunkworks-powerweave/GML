# Research 111

## D-001 — `t.skip()` vs `process.exit(0)` for unreachable-app handling

The first design question was: how do we make this file SAFE to run in
an environment where the app isn't up? Three options:

(a) Throw at module load — the entire file becomes "failed" and `pnpm
test:smoke` exits non-zero.
(b) `process.exit(0)` from a top-level guard — the file silently
"passes" with no test output, indistinguishable from "the file is
empty".
(c) Use `node:test`'s per-test `t.skip(reason)` API after a probe.

We picked (c). `t.skip()` reports as `skipped` in the TAP/summary
output, the reason string surfaces in the operator's terminal ("app not
reachable at http://localhost:3000 — set SMOKE_BASE_URL or `make up`
first"), and the process exit code is 0. This matches how `vitest.skip`
and `pytest.mark.skipif` work elsewhere — the operator sees that
something WAS supposed to run, just didn't, and gets actionable
remediation. (a) is the wrong UX for a CI box that doesn't have Docker;
(b) hides bugs by making the smoke pass silently.

## D-002 — AbortController vs `Promise.race` for the probe timeout

Node 18+'s `fetch` honours `AbortSignal`, so a 2-second probe is just
`new AbortController()` plus `setTimeout(() => ctl.abort(), 2000)`.
The alternative — `Promise.race([fetch(...), new Promise((_, rej) =>
setTimeout(rej, 2000))])` — works but leaks the underlying request: the
fetch keeps going after the race rejects. AbortController cancels the
socket, releases the file descriptor, and is the canonical pattern
documented in the Node fetch reference. Two seconds is a deliberate
choice: fast enough that an unreachable stack doesn't make
`pnpm test:smoke` feel hung, slow enough to absorb cold-start latency
on a fresh `make up`.

## D-003 — Narrowing the default `test` glob

Originally `"test": "node --test \"tests/**/*.test.mjs\""` greedily
matched everything under `tests/`. Adding `tests/integration/` would
have meant `pnpm test` runs the smoke too, which fails immediately
because most developer laptops don't have the Docker stack up. Options:

(a) Keep the wildcard, make smoke pass silently on unreachable —
breaks the "every test that runs is meaningful" principle.
(b) Move smoke outside `tests/` (e.g. `e2e/`) — works but breaks the
"governance test references file path" pattern other specs use.
(c) Narrow the `test` glob to `tests/governance/**/*.test.mjs` and add
a separate `test:smoke` for `tests/integration/`.

We picked (c). It mirrors how repos commonly separate unit / e2e (e.g.
`vitest run` vs `vitest run --config e2e.config.ts`). The naming
(`governance` vs `integration`) makes the intent self-documenting in
the directory tree. The future Run-9 work can add `tests/contract/` or
`tests/load/` under the same convention.

## D-004 — Accepting both 401 and 302-with-error for bad credentials

Auth.js v5 (which this repo uses, per spec 005) returns a 302 to
`/login?error=CredentialsSignin` on a failed credentials POST. We
tested with `redirect: "manual"` so the smoke sees the 302 directly
rather than chasing it. But: Auth.js v4 (still seen in some pinned
deployments) returns 401 with a JSON body. Rather than coupling the
smoke to one Auth.js version, test 4 accepts EITHER shape. The
underlying behaviour we care about — "wrong credentials don't grant a
session" — is the same in both.

## D-005 — Choosing `/dashboard` for the middleware-redirect check

The RBAC middleware (spec 007) protects every authenticated route. We
needed a path that (a) we know is gated, (b) exists in production
(not a 404 by name alone), and (c) is unambiguous about the unauth
behaviour. `/dashboard` was the obvious choice over `/inbox`,
`/profile`, etc — it's the canonical landing target after login and
the most likely page an unauthenticated user would try to bookmark.
Using `redirect: "manual"` lets us observe the 302 without following
it; otherwise `fetch` would follow the redirect and return the 200
from `/login`, which obscures whether middleware ran.
