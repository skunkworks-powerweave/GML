# Verification

Runtime evidence from actually booting the stack. Everything here was observed,
not inferred — each entry names the command and quotes the output.

**Status: FIRST REAL RUN — 2026-09-18.** This document previously read, in full:
*"Status: placeholder. First real entries from spec 002 onwards."* It stayed that
way through spec 171, while `PROGRESS.md` recorded `Tier-0 LAUNCH-READY ✅` and
cited this file as the evidence for it.

---

## Summary

The application **cannot serve its own login page** in the production image.
`docker compose up -d` cannot complete on any machine. Details below.

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (after removing a stray nested workspace root) |
| `pnpm lint` | PASS (was: never run — eslint absent from 2 of 3 configured workspaces) |
| `pnpm -r typecheck` | PASS (was: silently checked 1 of 5 workspaces) |
| `pnpm build` | PASS |
| `pnpm test` | PASS — 1549/1549, but see "What the tests prove" |
| `docker compose up -d` | **FAIL — cannot pull `minio/minio`** |
| `docker build` app image | **FAIL from a clean checkout** (fixed, see B10) |
| App container health | **unhealthy, permanently** |
| `GET /login` | **HTTP 500** |
| `GET /dashboard` | **HTTP 500** |
| `GET /api/health` | **HTTP 200 with `{"ok":false}`** |

---

## B9 — `docker compose up -d` cannot pull MinIO

```
$ docker compose up -d
 Image minio/minio:RELEASE.2025-04-08T15-41-24Z Error pull access denied for
 minio/minio, repository does not exist or may require 'docker login'
Error response from daemon: pull access denied for minio/minio
```

Not a pinned-tag or auth problem — the whole namespace is gone:

```
$ docker manifest inspect minio/minio:latest   -> denied
$ docker manifest inspect minio/mc:latest      -> denied
```

MinIO withdrew their public open-source images. `minio`, `minio-init` and `tusd`
can never start; `app` and `worker` both `depends_on: minio: service_healthy`, so
**nothing in the stack comes up at all**. `README-IT.md`'s "5-step deploy,
~30 minutes" is impossible on any host.

## B10 — the app image never built from a clean checkout

`.dockerignore` shipped at `docker/.dockerignore`, where Docker does not read it
(it reads the build-context root). Two consequences:

1. The build context was **735 MB**, almost all of it the host's Windows
   `node_modules`, which `COPY . .` then layered over the image's correctly
   installed Linux tree.
2. That accidental copy was the *only* reason the build worked. The builder stage
   copies just 2 of the 5 workspace `node_modules` trees, so on a clean clone
   `next build` fails:

```
Module not found  ./packages/db/src/client.ts
Module not found  ./packages/shared/src/api-contracts/ping.ts
Module not found  ./apps/worker/src/queues.ts
```

Fixed: `.dockerignore` moved to the context root (context now **227 KB**, a
~3,200x reduction) and the builder stage copies source first, then every
workspace dependency tree.

## B11 — the Edge middleware crashes on every request

```
Error: The edge runtime does not support Node.js 'stream' module.
  at .next/server/edge/chunks/[root-of-the-server]__02_aitv._.js
```

`middleware.ts` imports `auth` from `@/auth`, which pulls `DrizzleAdapter` → `pg`
→ Node `stream` into the Edge bundle. **The entire authorization layer — role
policies, section gates, the login redirect — throws at runtime in the production
image.** `next build` reports success; only running it reveals this.

## B12 — next-intl is not configured, so translated pages 500

```
Error: Couldn't find next-intl config file.
```

`apps/web/next.config.ts` contains only `output: "standalone"`. `createNextIntlPlugin()`
is never called and there is no `src/i18n/request.ts`, so the `NextIntlClientProvider`
in the authenticated layout cannot resolve its config. Every page that uses
translations returns 500 — including `/login`.

## B13 — the health endpoint reports success while the stack is broken

```
$ node -e "fetch('http://127.0.0.1:3000/api/health')..."
HTTP_STATUS=200
{"ok":false,"db":true,"redis":true,"minio":false,"migrations":false,
 "details":{"migrations":{"applied":0,"expected":22,
                          "error":"drizzle migrations table not found"}}}
```

HTTP **200** with `ok:false`. The Docker `HEALTHCHECK` and `deploy.sh`'s
`curl -fsS` both read only the status code, so both would call this healthy.
`applied: 0, expected: 22` also confirms there is no migration step anywhere in
`docker-compose.yml` — first boot is an empty database.

## B14 — the app healthcheck can never pass

```
$ docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' gml-lms-app-1
/bin/sh: 1: wget: not found     (x4)

$ docker run --rm --entrypoint sh gml-lms-app:latest -c 'command -v wget; command -v curl'
NO wget
NO curl
```

`node:22-slim` ships neither. `node` is the only usable binary in the image, so
the healthcheck must use `node -e "fetch(...)"`. Observed status after the start
period: **unhealthy**, and it stays that way.

## Route probe (production image, empty database)

| Route | Status | Note |
|---|---|---|
| `/` | 200 | no translations on this page |
| `/login` | **500** | next-intl config missing (B12) |
| `/dashboard` | **500** | middleware crash (B11) + B12 |
| `/api/ping` | 200 | no DB, no i18n, no middleware |
| `/api/health` | 200 | but `ok:false` (B13) |

## What the tests prove

`pnpm test` passes 1549/1549 assertions across 133 files. All 133 read source
files and regex-match their text; **not one imports application code** (verified:
every `import` in the suite is a Node builtin). The suite was fully green
throughout every failure documented above. The one behavioural file,
`tests/integration/smoke.test.mjs`, `test.skip()`s itself when the app is
unreachable, so it reports success against a stack that is not running.

## Environment limitations of this run

Stated so the results are not over-read:

- **Caddy** could not bind `:80` on this Windows host (`bind: An attempt was made
  to access a socket in a way forbidden by its access permissions`). Unrelated to
  the repository; the app was probed directly instead.
- **The worker image** could not be built here: `apt-get` fetches for ffmpeg were
  blocked by local antivirus (`499 Request has been forbidden by antivirus`). The
  worker's missing-source defect was therefore confirmed by reading
  `docker/worker.Dockerfile` (it contains no `COPY` of `apps/worker/src`), not by
  running it. Re-verify on a host with unrestricted egress.
- `minio`, `minio-init` and `tusd` were skipped via `--no-deps` after B9 made them
  unpullable.
