# Tasks 165

- [x] T1 → write the governance test (red) covering:
  - `.github/workflows/test.yml` exists.
  - The file is structurally valid YAML (regex-checked for the
    key shape `on:`, `jobs:`, `runs-on:`).
  - The workflow references `pnpm install --frozen-lockfile`,
    `pnpm test`, `pnpm build`, and `pnpm -r typecheck` in its
    step list.
  - The workflow declares `cache: "pnpm"` on the setup-node step.
  - The workflow triggers include both `push` and `pull_request`.
  - `.github/workflows/README.md` exists and is short.
  Run suite → red.
- [x] T2 → create `.github/workflows/test.yml`. Use
  `pnpm/action-setup@v4` without a `version:` input so the
  `packageManager` field in the root `package.json` is the single
  source of truth for the pnpm version. Use
  `actions/setup-node@v4` with `node-version: 22` and
  `cache: "pnpm"`. Set `DATABASE_URL` at the job env level for the
  build step. Run the suite → workflow-file assertions green.
- [x] T3 → create `.github/workflows/README.md`. Three lines:
  what the workflow gates, when it runs, which spec authored it.
- [x] T4 → author all five spec-kit files under
  `specs/165-ci-cd-pipeline/`.
- [x] T5 → run the full governance suite. Confirm no regression —
  the spec adds only `.github/` files plus the spec-kit + the new
  governance test; no other governance test reaches into
  `.github/`.
- [ ] T6 (future, out of scope) → add a `deploy` job that builds
  and pushes a worker Docker image to a registry on every `main`
  push. Out of scope here because the Ops cluster's image registry
  is not yet provisioned and the worker doesn't yet have a
  hardened `Dockerfile`.
- [ ] T7 (future, out of scope) → add a service-container
  declaration so `pnpm test:smoke` boots the actual Docker stack
  on the CI runner. Out of scope because the docker-compose
  topology is dev-flavoured (volumes, bind mounts) and porting it
  to a CI-friendly shape is its own spec.
- [ ] T8 (future, out of scope) → add a matrix dimension for
  Node 24 as it approaches LTS. Out of scope because the project
  pins `engines: { node: ">=22" }` and there's no current need
  for back-compat testing.
- [ ] T9 (future, out of scope) → wire CodeQL or a similar
  security scanner into a separate workflow that runs nightly.
  Out of scope; the project surface is internal-only per the
  GML LMS Decisions memory note.
- [ ] T10 (future, out of scope) → cache the `.next/` build
  output across runs. Out of scope because Next.js cache
  invalidation is subtle and current build times are sub-minute.
