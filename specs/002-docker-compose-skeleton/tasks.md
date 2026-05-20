# Tasks 002 — Docker Compose Skeleton

TDD-ordered.

## T1 — Write the governance test FIRST (red phase)

- [ ] Create `tests/governance/test_002_compose_skeleton.test.mjs` asserting:
  - `docker-compose.yml` parses as YAML and has services for: caddy, app, worker, tusd, postgres, redis, minio
  - Each service has a top-of-block comment (regex `# .+`)
  - Named volumes section includes: pgdata, miniodata, caddy_data, caddy_config, redisdata
  - Files exist: `docker/app.Dockerfile`, `docker/worker.Dockerfile`, `docker/Caddyfile`
  - `apps/web/src/app/api/health/route.ts` exists and contains `export async function GET`
  - `apps/web/next.config.ts` contains `output: "standalone"`
- **Verify red:** `node --test tests/governance/test_002_compose_skeleton.test.mjs` fails on missing files.

## T2 — Health route + Next.js standalone config

- [ ] `apps/web/src/lib/health.ts` — three async ping helpers (db, redis, minio) using dynamic imports
- [ ] `apps/web/src/app/api/health/route.ts` — exports `GET` that awaits all three pings in parallel
- [ ] Edit `apps/web/next.config.ts` → add `output: "standalone"`

## T3 — Dockerfiles

- [ ] `docker/app.Dockerfile` — multi-stage (deps / builder / runner)
- [ ] `docker/worker.Dockerfile` — node:22-slim + ffmpeg apt + worker package install
- [ ] `docker/.dockerignore`

## T4 — Caddyfile

- [ ] `docker/Caddyfile` — site `{$DOMAIN}`; route `/api/*` and `/` to `app:3000`; route `/uploads/*` to `tusd:1080`; generous body sizes for `/uploads/*` and `/api/webhooks/*`; `tls internal` if `DOMAIN=localhost`

## T5 — docker-compose.yml

- [ ] 7 services with role-comments
- [ ] Named volumes
- [ ] depends_on chain
- [ ] healthchecks where supported
- [ ] env-var interpolation only (no hardcoded passwords)
- [ ] Network `lms_net` (bridge)

## T6 — Validate compose file (manual)

- [ ] `docker compose config -q` from `lms-app/` exits 0 (validates YAML + env interpolation, doesn't pull images)
- [ ] If errors, fix and re-run

## T7 — Green phase verification

- [ ] Re-run `node --test tests/governance/test_002_compose_skeleton.test.mjs` → all assertions pass
- [ ] Existing `test_001_*` test still passes (sanity)

## T8 — Run-time smoke test (manual, deferred)

- [ ] Document in `docs/verification.md`: `docker compose up -d`, wait 60s, `docker compose ps`, `curl -sk https://localhost/api/health`. Capture output in ledger entry.
- [ ] Smoke test is OPTIONAL for spec closure if Docker Desktop is paused — the ledger entry records "not yet run" with a TODO for next session.

## T9 — First git commit

- [ ] `git add -A` from `lms-app/`
- [ ] `git -c commit.gpgsign=false commit -m "feat(scaffold): pnpm workspace + Next.js + .claude harness + docker-compose stack"` (gpg disabled because there's no key set up yet on this machine — note in ledger; future commits can use signed commits if a key exists)
- [ ] `git log --oneline` shows the first commit

## T10 — Append PROGRESS.md ledger entry

- [ ] Append spec 002 COMPLETE block
- [ ] Update status board: Phase 0: done 2, in_progress 1, todo 0; total done 2
- [ ] Check off `002-docker-compose-skeleton`; mark 003 as `← next`
- [ ] Update `workspace/state.json` → `currentSpec: "003", specsCompleted: 2, completedSpecs: ["001-...", "002-..."]`
