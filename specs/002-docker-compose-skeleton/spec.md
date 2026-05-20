# Spec 002 — Docker Compose Skeleton

**Status:** in_progress
**Date:** 2026-05-20
**Author:** GML LMS team
**Constitution Check:** N/A (no business logic; substrate moats SM-1..SM-6 land in 011)

---

## Overview

Land the 7-service `docker-compose.yml` stack so `docker compose up -d` from `lms-app/` brings up a working development environment: postgres, redis, minio, tusd, app (Next.js), worker, caddy. Includes the two Dockerfiles (`app.Dockerfile`, `worker.Dockerfile`), the `Caddyfile`, and the `/api/health` route in `apps/web` so the readiness check has something to talk to.

This spec is the "you can run the stack locally" milestone. No DB schema yet (that's 004), no auth (005), no business features.

---

## User Stories

**US1 (Developer — local stack):**
As the developer, when I run `docker compose up -d` from `lms-app/`, all 7 services start and reach `healthy` (or `running`) within ~90 seconds on a typical laptop. `docker compose ps` shows them all up.
**Independent Test:** `cd lms-app && docker compose up -d && docker compose ps --format json | findstr healthy` returns ≥ 5 healthy lines (caddy + app + postgres + redis + minio; tusd and worker may show only "running" since they don't expose `HEALTHCHECK`).

**US2 (Developer — health endpoint):**
As the developer, after the stack is up I can `curl https://localhost/api/health` (with `-k` for self-signed local TLS) and get `{ok: true, db: <bool>, redis: <bool>, minio: <bool>}`.
**Independent Test:** `curl -sk https://localhost/api/health | jq .ok` returns `true`. Bonus: each sub-system returns its own status, and we can intentionally fail one (e.g. stop postgres) and see `db: false`.

**US3 (Developer — clean teardown):**
As the developer, `docker compose down` stops everything cleanly without losing data. `docker compose up -d` immediately afterwards resumes from the same state (no re-init).
**Independent Test:** Up → write a row to postgres via a one-off `psql` command → down → up → row still there.

**US4 (IT — deploy story preview):**
As GML's IT team, when I read `README-IT.md` (which lands fully in spec 069 but starts being useful now), I can see what each service does and what env vars it needs. The compose file is readable.
**Independent Test:** Open `docker-compose.yml` — every service has a comment explaining its role; every env var ties back to `.env.example`.

---

## Functional Requirements

- **FR-001 (7 services)**: `docker-compose.yml` defines `caddy`, `app`, `worker`, `tusd`, `postgres`, `redis`, `minio` on a bridge network `lms_net`.
- **FR-002 (named volumes)**: `pgdata`, `miniodata`, `caddy_data`, `caddy_config`, `redisdata` — all named (no bind mounts into the OneDrive tree). Worker tmp uses tmpfs.
- **FR-003 (start order)**: postgres → redis → minio → tusd → app → worker → caddy. Encoded via `depends_on` with `condition: service_healthy` where supported, `service_started` otherwise.
- **FR-004 (env-driven)**: every service reads from the single `.env` file at the compose root. No hardcoded passwords or domains in the yaml.
- **FR-005 (healthchecks)**: postgres uses `pg_isready`; redis uses `redis-cli ping`; minio uses its `/minio/health/live`; app uses `wget --spider http://localhost:3000/api/health`; caddy uses `wget --spider http://localhost`.
- **FR-006 (caddy TLS)**: in production mode (`DOMAIN` set to a real domain), Caddy auto-requests Let's Encrypt certs; in local mode (`DOMAIN=localhost`), Caddy issues a local-only self-signed cert via its internal CA.
- **FR-007 (app Dockerfile)**: multi-stage build — `deps` (pnpm install --frozen-lockfile), `builder` (pnpm --filter @gml/web build), `runner` (Node 22 slim + standalone Next.js output). Uses Next.js's `output: "standalone"` config.
- **FR-008 (worker Dockerfile)**: Node 22 slim + `ffmpeg` apt package + pnpm install of `@gml/worker`.
- **FR-009 (/api/health route)**: `apps/web/src/app/api/health/route.ts` exports `GET` returning `{ ok: true, app: true, db: <ping>, redis: <ping>, minio: <ping> }`. Pings degrade gracefully when env vars are absent (returns `false` not 500).
- **FR-010 (Caddyfile)**: route `/` and `/api/*` to `app:3000`; route `/uploads/*` to `tusd:1080`; long timeouts for upload routes; max body 0 (unlimited) for `/uploads/*` and `/api/webhooks/whatsapp` (large media).
- **FR-011 (first git commit)**: from `lms-app/`, the first commit includes everything from spec 001 + spec 002. Commit message: `feat(scaffold): pnpm workspace + Next.js + .claude harness + docker-compose stack`.

---

## Security Constraints

- **SC-001**: bucket policy in MinIO must default to *private*; public reads forbidden. (Enforced in spec 022; spec 002 sets the env vars but doesn't seed the bucket.)
- **SC-002**: postgres exposes port 5432 only on the docker bridge network; **not** mapped to the host in production. In dev it may be mapped to `127.0.0.1:5432` for `psql` access — gated on `NODE_ENV != production`.
- **SC-003**: `caddy` is the only service with ports mapped to the host (80 + 443).

---

## Independent Test (composite)

```powershell
cd C:\Users\himan\OneDrive\Desktop\GML\lms-app
Copy-Item .env.example .env             # FIRST TIME ONLY — then edit DOMAIN, passwords
docker compose config -q                # FR-001..FR-004 — validates yaml + env interpolation
docker compose up -d                    # US1
Start-Sleep -Seconds 60                  # let healthchecks settle
docker compose ps                       # US1 — expect ≥ 5 healthy
curl -sk https://localhost/api/health | jq .ok    # US2 — should return true
docker compose down                     # US3 — clean stop
docker compose up -d                    # US3 — resume
```

Plus the governance test (`tests/governance/test_002_compose_skeleton.test.mjs`) checks:
- `docker-compose.yml` parses as YAML and contains exactly the 7 services
- Each service references the named-volume pattern, not host bind mounts (except caddy's well-known dirs)
- `app.Dockerfile`, `worker.Dockerfile`, `docker/Caddyfile` exist
- `apps/web/src/app/api/health/route.ts` exists and exports a `GET` handler

---

## Out of scope (for this spec)

- DB schema or migrations (spec 004)
- MinIO bucket policy and signed-URL middleware (spec 022)
- WhatsApp webhook configuration (spec 028)
- Production deploy script and backup cron (spec 067)
- Caddy auto-TLS test against a real domain (spec 068)
- Loading testing (spec 066)
