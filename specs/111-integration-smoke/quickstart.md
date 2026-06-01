# Quickstart 111

Boot the stack with `make up`, wait for `/api/health` to flip green, then
run `pnpm test:smoke`. Expected output: 8 passing tests, all under three
seconds. To exercise the skip path, stop the web container (`docker
compose stop web`) and re-run — you should see 8 skipped tests with the
reason `app not reachable at http://localhost:3000`. To point the smoke
at a remote deploy, export `SMOKE_BASE_URL=https://lms.staging.gml`
before running. The default `pnpm test` still excludes this file: it
runs only `tests/governance/**/*.test.mjs`, so PR CI stays green without
a live Docker stack.
