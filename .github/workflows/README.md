# CI workflows

`test.yml` runs on every push to `main` and every pull_request. Gates the merge on
`pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`, `pnpm -r typecheck`, and a
lenient `pnpm test:smoke` (skips when the Docker stack is unreachable). Per Spec 165.
