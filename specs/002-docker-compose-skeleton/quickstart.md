# Quickstart 002 — Docker Compose Skeleton

## What you get after this spec

A bootable local stack: postgres + redis + minio + tusd + app + worker + caddy, all coordinated by one `docker-compose.yml`. Visit `https://localhost/api/health` and see the readiness state.

## Run it

```powershell
cd C:\Users\himan\OneDrive\Desktop\GML\lms-app

# First time only: copy and edit .env
Copy-Item .env.example .env
# Edit .env — at minimum set:
#   DOMAIN=localhost
#   POSTGRES_PASSWORD=anything
#   MINIO_ROOT_PASSWORD=anything (≥ 8 chars)
#   AUTH_SECRET=anything (≥ 32 chars)
#   SUPER_ADMIN_INITIAL_PASSWORD=anything

# Validate the compose file (no images pulled)
docker compose config -q

# Pull images and start (first run ~3-5 minutes)
docker compose up -d

# Watch services start
docker compose ps

# When all show "running" or "healthy":
curl -sk https://localhost/api/health
# expected: {"ok":true,"app":true,"db":false,"redis":false,"minio":false}
# (db/redis/minio false because no real client code yet — that lands in spec 004+)
```

## Verify the stack is alive

```powershell
# 7 services, all running
docker compose ps --format "table {{.Service}}\t{{.Status}}"

# Per-service quick smoke:
docker compose exec postgres pg_isready              # ready
docker compose exec redis redis-cli ping              # PONG
curl http://localhost:9000/minio/health/live           # 200 OK (MinIO is internal but exposes health)
curl -sk https://localhost/api/health | jq            # JSON readiness
```

## Stop / restart

```powershell
docker compose down                  # graceful stop, volumes preserved
docker compose up -d                 # resume — data still there
```

## Reset (DESTRUCTIVE — only when you really want to wipe)

```powershell
docker compose down -v               # also removes named volumes
```

Note: this is one of the patterns `scripts/block_destructive.mjs` refuses by default. Pass `--explicit-confirm-yes-wipe` (handled in spec 067) or run the docker command directly.

## Troubleshooting

- **`port 443 already in use`** — another service is listening (Skype, IIS, another dev server). Stop it or change Caddy's port mapping.
- **TLS warning in browser** — expected for `DOMAIN=localhost`. Caddy's internal CA is self-signed. Either trust the cert in Windows certmgr or use `curl -k`.
- **`docker compose up` is slow on first run** — initial image pulls. Subsequent ups are seconds.
- **OneDrive complains about lockfiles** — `docker-volumes/` should be a named volume (not a bind mount). If you see Docker writing into the OneDrive tree, check the compose file's volume declarations.
