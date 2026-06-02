# Research 165

Design choices, documented for the next contributor who might want
to extend the CI surface.

## (1) Why GitHub Actions over GitLab CI / CircleCI / Jenkins / Drone

The repo lives on GitHub. Every alternative CI provider would
require setting up a webhook, managing a separate credentials
store, and learning a second config language. GitHub Actions is
free for public repos, generously priced for private repos, and
the `.github/workflows/` directory is the universally-recognised
convention — a future maintainer looking for "where does the CI
live" will look there first.

Rejected alternatives:

- **GitLab CI** — would require either migrating the repo to
  GitLab or running a runner that mirrors PRs from GitHub to a
  GitLab project. Both add friction for zero benefit.
- **CircleCI** — solid product, but a second auth surface and a
  separate billing relationship for ~50 lines of YAML.
- **Jenkins** — heavyweight, needs a hosted runner the project
  doesn't have.
- **Drone** — niche, would need infrastructure to host.
- **Husky pre-commit hooks alone** — these CAN'T enforce; a
  contributor can `git commit --no-verify` and bypass. CI is the
  only point where the gate is GUARANTEED.

## (2) Why `pnpm/action-setup@v4` over installing pnpm via `npm i -g`

The marketplace action handles three subtleties that the manual
install gets wrong:

- **Version pinning from `packageManager` field.** When no `version:`
  input is given to `pnpm/action-setup@v4`, it reads the
  `packageManager` field from the root `package.json` and pins the
  install to that exact version. `package.json` currently declares
  `pnpm@10.33.4`. The manual `npm i -g pnpm` install picks up the
  latest tagged release, which can silently shift the pnpm major
  version between runs and break the lockfile.
- **Caching the pnpm store.** The action plays nicely with
  `actions/setup-node@v4`'s `cache: "pnpm"` option — it sets up the
  shim so setup-node can locate the pnpm store at the correct path
  on the runner. Manual install would skip this and force a fresh
  install on every run, doubling the CI wall-clock time.
- **No-op when pnpm is already on the PATH.** The action detects
  that pnpm is installed (e.g. via Corepack) and short-circuits.
  Manual install would either fail (conflict) or layer a second
  binary on top of the system pnpm.

## (3) Why Node 22 (not 20 or 18)

The root `package.json` declares `engines: { "node": ">=22" }`.
Per spec 004 (when Drizzle landed), the project's minimum supported
runtime is Node 22. Running CI on a lower version would mean either
the runtime is incompatible OR we're testing a configuration
that production won't use — either way, false signal.

A future spec could add a matrix `node-version: [22, 24]` if the
project decides to test against the next LTS pre-release. Not now;
the value is low and the runner-minutes cost real.

## (4) Why `cache: "pnpm"` on the setup-node step (not a separate `actions/cache@v4`)

`actions/setup-node@v4` has built-in support for pnpm caching via
the `cache: "pnpm"` input. Behind the scenes it calls
`pnpm store path` to find the store, then keys the cache on the
hash of `pnpm-lock.yaml`. A manual `actions/cache@v4` step would
require us to:

- Run `pnpm store path` and capture the output.
- Hash `pnpm-lock.yaml` manually and pass it as the cache key.
- Restore on the right step in the order.

All three are subtle, and the setup-node integration handles them.
The cost is one input: `cache: "pnpm"`. Free correctness.

## (5) Why `pnpm install --frozen-lockfile` (not `pnpm install` or `pnpm i --no-frozen`)

The `--frozen-lockfile` flag is the load-bearing reproducibility
gate. Without it, `pnpm install` would silently update the
`pnpm-lock.yaml` file if `package.json` has drifted, then succeed.
On a CI runner that's exactly what we DON'T want — the goal is to
verify that the lockfile committed to the repo matches the
`package.json` exactly. If a contributor forgot to commit the
updated lockfile after adding a dependency, `--frozen-lockfile`
catches it as a CI failure rather than masking it as a clean install.

## (6) Why `pnpm test:smoke || true` (lenient) instead of `pnpm test:smoke` (strict)

The smoke suite (`tests/integration/smoke.test.mjs` per spec 003)
exists to verify that the Docker stack from `docker-compose.yml`
boots cleanly and the basic application surfaces respond. On a
fresh CI runner, the Docker stack is NOT booted (the runner doesn't
even have the project's docker-compose file initialised). The
smoke tests have an internal `test.skip` per spec 003 that detects
connection refusal and gracefully skips — but a runner with NO
docker socket at all could exit non-zero from a deeper system
error before the test runner can run.

`|| true` keeps the gate green in that scenario. The smoke suite
is still EXERCISED on every CI run; a future spec can add a
service-container declaration in the workflow YAML to boot the
Docker stack and remove the `|| true`. For now, the smoke suite is
opportunistic — it runs when it can.

Alternative considered: only run smoke on a separate job that has
its own service-container declaration. Rejected because the
matrix complexity adds runner minutes for zero current value (the
governance suite covers the load-bearing assertions; smoke is
sanity).

## (7) Why `pnpm -r typecheck` (recursive) instead of explicit per-workspace calls

The `-r` flag tells pnpm to run the script in every workspace that
declares it. Today, only `packages/db` declares a `typecheck`
script — but the gate is structured so a future workspace can
add `"typecheck": "tsc --noEmit"` to its `package.json` and the CI
automatically picks it up. Explicit per-workspace calls
(`pnpm --filter @gml/db typecheck`) would need to be updated every
time a workspace gains a typecheck script — a maintenance burden.

The `--if-present` flag is NOT used here because we want a hard
failure if `pnpm -r typecheck` can't find the script when expected.
Per spec 004, `packages/db` MUST have a typecheck script — if it's
ever removed, the CI failure is the right signal.

## (8) Why `DATABASE_URL` is set at the job env level (not on each step)

`packages/db/src/client.ts` reads `DATABASE_URL` at module-import
time. The `pnpm build` step imports the client transitively when
Next.js compiles the API routes. Without an env value, the client
would either crash OR fall back to its spec 143 build-safe stub
(`postgres://stub:stub@stub:5432/stub`). The fallback works, but
setting an explicit DATABASE_URL at the job level is clearer to a
future contributor reading the YAML — they see immediately what
the build expects, without having to read the spec 143 source.

The placeholder value (`postgres://gml:postgres@localhost:5432/gml_lms_test`)
is intentionally unreachable at CI runtime — there's no Postgres
running on the runner. The CI gate is for static checks (test,
build, typecheck); the smoke suite is the only step that would
need a real DB, and that step is lenient (`|| true`).

## (9) Workflow naming — `test-and-build` over `ci` or `main`

GitHub Actions surfaces the workflow name in the PR check UI. A
generic name like `ci` would force a reader to click through to
see what runs. `test-and-build` is self-documenting — it tells a
reviewer at-a-glance that this gate covers BOTH the test suite AND
the build. The job within the workflow shares the same name; this
is intentional so the GitHub PR UI shows a single check named
`test-and-build` rather than `ci / test-and-build`.

## (10) Why no caching of the Next.js `.next/` directory

A `.next/cache/` mount could speed up the Next.js build by reusing
the previous build's output. Two reasons we skip this:

- **Cache invalidation is hard.** Next.js's build cache is keyed on
  the source-file hashes plus the environment; getting the cache
  key right is error-prone and a stale-cache miss would produce a
  silently-wrong build that ships to prod.
- **Build time is small.** The current build runs in well under a
  minute. The cost of cache-tuning would exceed the saved minutes.

A future spec can add this if build time becomes a bottleneck.
