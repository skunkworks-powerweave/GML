# Research 002 — Docker Compose Skeleton

## Decisions

### D-001: Multi-stage Dockerfile uses Next.js `output: "standalone"`

**Context:** Next.js can produce a "standalone" output that bundles only the runtime files needed to serve the app — smaller image, faster cold start.

**Resolution:** Add `output: "standalone"` to `apps/web/next.config.ts`. The runner stage copies just `.next/standalone/`, `.next/static/`, and `public/`.

**Why:** ~75 % smaller image vs a full-source-tree Docker image.

### D-002: Node 22-slim, not Alpine

**Context:** Alpine images are smaller but use musl-libc, which sometimes causes native-module pain (sharp, libvips, ffmpeg builds). Node 22-slim is Debian-based glibc and runs the same wheel as the dev environment.

**Resolution:** All custom images use `node:22-slim`. Trade ~50 MB for predictability.

### D-003: ffmpeg via apt on worker, not a separate `jrottenberg/ffmpeg` image

**Context:** Could either have the worker shell out to an ffmpeg sidecar container, or install ffmpeg inside the worker image.

**Resolution:** install ffmpeg inside the worker (`apt-get install -y ffmpeg`). One container, one job runner, fewer moving parts. The trade-off — image is ~150 MB larger — is dwarfed by simplicity gains.

### D-004: tusd as a separate service, not embedded in Next.js

**Context:** tusd is the canonical resumable-upload server implementing the tus protocol. Running it as its own service is the documented production pattern. We could implement tus inside Next.js but it would mean reimplementing a tested protocol.

**Resolution:** tusd container, S3 backend pointing at MinIO. Caddy routes `/uploads/*` to tusd.

### D-005: Caddy `internal` cert for localhost; Let's Encrypt for real domains

**Context:** In dev (`DOMAIN=localhost`) we don't want LE attempts (would fail). In prod (`DOMAIN=lms.foo.org`) we do.

**Resolution:** Caddyfile uses `tls internal` if `DOMAIN=localhost`, falls through to default LE behaviour otherwise. Caddy's matcher syntax makes this a one-liner.

### D-006: Don't expose Postgres / Redis / MinIO ports to the host in production

**Context:** Easy to leak by accident. We can dev with `127.0.0.1:5432:5432` for psql convenience, but production should keep DB internal.

**Resolution:** the host port mapping is wrapped in a conditional via Compose override: base `docker-compose.yml` does not map DB ports; `docker-compose.dev.yml` (gitignored or opt-in) adds them. In production, only Caddy's 80 + 443 reach the host.

### D-007: First git commit covers spec 001 + 002 together

**Context:** Recorded in spec 001 (D-003). Commit message: `feat(scaffold): pnpm workspace + Next.js + .claude harness + docker-compose stack`.

**Why:** the first commit being a bootable stack is a more useful checkpoint than an empty workspace.

### D-008: pg / ioredis / undici imports happen lazily inside the health route

**Context:** Importing `pg` and `ioredis` at module load means the route still loads even before we install them — but right now `apps/web/package.json` doesn't have those deps.

**Resolution:** Use **dynamic imports** inside the health-route handler, wrapped in try/catch. If the module isn't installed yet, the sub-system pings return `false` instead of crashing the route. This decouples the health route from spec 004 (DB) and spec 022 (MinIO) where those clients land properly.

**Trade-off:** slightly slower first request to /api/health. Acceptable.

## Alternatives considered

### A-001: Use `docker compose` with profile flags instead of a separate dev compose file
- **Decision:** defer. Profiles work but the operator has to remember `--profile dev`. Simpler to ship two YAML files (one base, one override). Reconsider when the dev/prod variance grows.

### A-002: Use Bitnami images instead of upstream postgres / redis
- **Decision:** stick with official. Bitnami images bundle some convenience config but also bring their own opinions; we want vanilla so the experience matches the docs.

### A-003: Pin specific image tags vs `:alpine` / `:latest`
- **Decision:** pin to a specific minor version (`postgres:16.4-alpine` not `postgres:alpine`). Reproducibility matters for an IT-deployed stack.

## Context

- PLAN.md § "Architecture" and § "Self-host deployment" are authoritative for the service topology
- Spec 001 ledger entry pre-recorded that the first git commit lands in spec 002
- All env vars referenced by docker-compose.yml must appear in `.env.example` (already shipped in spec 001)
