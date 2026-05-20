# Plan 002 — Docker Compose Skeleton

**Spec:** `specs/002-docker-compose-skeleton/spec.md`
**Date:** 2026-05-20
**Constitution Check:** PASS (no substrate moats touched)

## Implementation Blueprint

### Phase 2 — Foundational (docker-compose + Dockerfiles + Caddyfile)

Files CREATED:
- [P] `docker-compose.yml` — 7 services on `lms_net`; named volumes; healthchecks; depends_on chain; env interpolation from `.env`
- [P] `docker/app.Dockerfile` — multi-stage: `deps`, `builder`, `runner` (Node 22-slim + Next.js standalone output)
- [P] `docker/worker.Dockerfile` — Node 22-slim + `ffmpeg` + pnpm install of `@gml/worker`
- [P] `docker/Caddyfile` — site `{$DOMAIN}` (resolves to `localhost` in dev), routes `/api/*` and `/` to `app:3000`, `/uploads/*` to `tusd:1080`, generous body sizes
- [P] `docker/.dockerignore` — excludes node_modules, .next, workspace, specs, docs, .git

### Phase 3 — Integration (Next.js standalone + health route)

Files MODIFIED:
- `apps/web/next.config.ts` — add `output: "standalone"` so the Docker image stays small
- `apps/web/package.json` — no change needed (next start works out of the standalone output)

Files CREATED:
- `apps/web/src/app/api/health/route.ts` — `GET` returns JSON with per-subsystem pings:
  - `app: true` (always)
  - `db: <bool>` — uses `pg.Pool` ping if `POSTGRES_HOST` env set
  - `redis: <bool>` — uses `ioredis.ping` if `REDIS_URL` env set
  - `minio: <bool>` — fetches `${MINIO_ENDPOINT}/minio/health/live` if set
- `apps/web/src/lib/health.ts` — the per-subsystem ping helpers (so the route stays thin)

### Phase 4 — Test coverage

Files CREATED:
- `tests/governance/test_002_compose_skeleton.test.mjs` — asserts:
  - `docker-compose.yml` parses as YAML and contains services: caddy, app, worker, tusd, postgres, redis, minio
  - Each service has a comment with its role (regex check in raw text)
  - Named volumes declared: pgdata, miniodata, caddy_data, caddy_config, redisdata
  - Dockerfiles + Caddyfile exist
  - `apps/web/src/app/api/health/route.ts` exists and exports `GET`
  - `apps/web/next.config.ts` contains `output: "standalone"`

### Phase 5 — Verification (manual, documented)

Auto-tests cover the file shape. The runtime smoke test (`docker compose up -d` → health check) is documented in `docs/verification.md` and runs **manually** the first time. We do NOT block spec closure on docker actually running, because:
1. The OS may have Docker Desktop paused
2. Image pulls (~2 GB) are slow on first run
3. The auto-mode harness shouldn't kick off long-running daemons without explicit operator OK

The ledger entry will note whether the manual smoke test was run and what the result was.

### Phase 6 — First git commit

After tests pass, run from `lms-app/`:
```
git add .
git commit -m "feat(scaffold): pnpm workspace + Next.js + .claude harness + docker-compose stack"
```

## Data flow (post-spec-002, when stack is running)

```
Browser → :443 → caddy (TLS termination)
  ├─ /api/* + /  → app:3000 (Next.js)
  │                  ├─ GET /api/health → reads env, pings db/redis/minio
  │                  └─ (LMS routes — land in spec 032+)
  └─ /uploads/*  → tusd:1080 (resumable upload protocol)
                     └─ S3 backend → minio:9000

Background:
  worker → bullmq queue on redis:6379 → (no jobs yet — spec 024)
```

## Corrections applied

(None — first iteration of spec 002.)
