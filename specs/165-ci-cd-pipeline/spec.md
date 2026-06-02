# Spec 165 — CI/CD pipeline (Workflow Run 16 audit closure)

## Why

The Workflow Run 16 post-audit sweep flagged the absence of any
automated CI gate as a **BLOCKER**. At the moment the repo's quality
bar is enforced entirely by the developer running `pnpm test` and
`pnpm build` locally before committing. 163 specs have shipped with
1423 governance assertions, a TypeScript surface across `apps/web`,
`apps/worker`, `packages/db`, `packages/shared`, and `packages/ui`,
plus a smoke-test suite for integration coverage — but the only
thing standing between a regression and the `main` branch is the
contributor's discipline.

Three concrete failure modes the audit identified, each of which a
trivial GitHub Actions config would prevent:

1. **A contributor runs `pnpm test` from a stale checkout** (forgets
   to `pnpm install` after a lockfile update), the tests pass against
   the cached node_modules, then the same tests fail in production
   the next morning when a fresh deploy syncs the lockfile.

2. **A contributor edits a `.ts` file in `packages/db` that compiles
   under `pnpm build` (which doesn't invoke `tsc` for that workspace
   today) but fails `pnpm -r typecheck`.** The error is invisible
   locally if the dev didn't run typecheck — the next person to touch
   that file inherits a broken HEAD.

3. **A future contributor refactors something benign in
   `apps/web` and inadvertently breaks a worker job-handler import.**
   Without CI gating the merge, the break lands silently and ships
   to the next user of the worker (in this codebase, an Ops runtime
   on the LMS cluster).

The fix is a single GitHub Actions workflow file: ~50 lines of YAML,
one job, five steps. Zero new dependencies, zero source-code change
to the application itself, zero CI infrastructure burden — GitHub
Actions is free for public repos and within the free-tier minutes
budget for the size of this project.

## What we ship

### `.github/workflows/test.yml` (CREATED)

A single GitHub Actions workflow named `test-and-build`. Triggers on
`push` to `main` and on every `pull_request` (any branch). Single
job `test-and-build` runs on `ubuntu-latest` and executes the
following steps in order:

1. `actions/checkout@v4` — pull the source.
2. `pnpm/action-setup@v4` — install pnpm. No `version:` input is
   given; the action auto-detects the `packageManager` field in
   `package.json` (currently `pnpm@10.33.4`).
3. `actions/setup-node@v4` with `node-version: 22` and
   `cache: "pnpm"` — pnpm-aware dependency cache restored from the
   lockfile hash.
4. `pnpm install --frozen-lockfile` — install dependencies, fail
   the job if the lockfile has drifted from `package.json`.
5. `pnpm test` — run the 1423 governance assertions.
6. `pnpm build` — Next.js production build + worker compile.
7. `pnpm -r typecheck` — `tsc --noEmit` per workspace that defines
   the script (today: `packages/db`; future workspaces will pick up
   the gate automatically as they add the script).
8. `pnpm test:smoke || true` — run the integration smoke suite, but
   `|| true` so a clean PR that hasn't booted the Docker stack on
   the runner doesn't fail the gate. The smoke tests themselves
   already `test.skip` on connection refusal (per spec 003), but
   the `|| true` is belt-and-suspenders for a runner with no Docker
   at all.

Sets `DATABASE_URL=postgres://gml:postgres@localhost:5432/gml_lms_test`
as a job-level env variable so `packages/db/src/client.ts` can load
its singleton without crashing during `pnpm build`. The client has
a build-safe fallback per spec 143, but explicit beats implicit on
a fresh CI runner.

### `.github/workflows/README.md` (CREATED)

A short (3-line) note explaining what the workflow gates and which
spec authored it.

## Acceptance criteria

- `.github/workflows/test.yml` exists and is valid YAML.
- The workflow declares triggers `on:` containing both `push`
  (with `branches: [main]`) and `pull_request`.
- The workflow declares a single job running on `ubuntu-latest`.
- The job uses `pnpm/action-setup@v4` and `actions/setup-node@v4`.
- `cache: "pnpm"` is set on the setup-node step so the dependency
  cache is restored across runs.
- The job runs `pnpm install --frozen-lockfile`, `pnpm test`,
  `pnpm build`, and `pnpm -r typecheck` in that order.
- The job runs `pnpm test:smoke || true` so the smoke suite is
  exercised but lenient when the Docker stack is unreachable.
- `DATABASE_URL` is set at the job env level so build-time imports
  of `packages/db/src/client.ts` don't crash.
- `.github/workflows/README.md` exists and is short (under 10 lines).
- All five spec-kit files exist under `specs/165-ci-cd-pipeline/`.
- `tests/governance/test_165_ci_cd_pipeline.test.mjs` passes with at
  least 5 assertions covering the above.

## Non-goals

- **No deploy stage.** This spec only adds the build/test gate. A
  future spec can add a `deploy` job that pushes the worker image
  to a registry or rolls the web app onto the Ops cluster. The Ops
  cluster runtime is OUT of scope for this CI iteration.
- **No matrix builds.** Node 22 is the only supported version (per
  `package.json` engines field). A future spec could add Node 20 to
  the matrix if the project ever needs back-compat. Not yet.
- **No PR-comment integration.** A future spec could wire the
  governance failures into PR review comments via a status-check
  app. Out of scope; the default GitHub Actions UI is good enough.
- **No new application-side code.** Zero `.ts` / `.tsx` files are
  touched. Zero migrations. Zero schema delta. Zero new package
  dependencies. The change is ENTIRELY in `.github/workflows/`.
- **No secrets configuration.** The workflow uses a placeholder
  `DATABASE_URL` for the local-only build step. Production secrets
  are managed by the Ops cluster, not by GitHub Actions, because
  this CI gate runs only as a build/test verifier — it does not
  touch any real database.
- **No artifact upload.** A future spec could persist the Next.js
  `.next/` output as a build artifact for download. Out of scope.
