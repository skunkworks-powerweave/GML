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

---

# Authorization verification (Phase 3)

Executed over real HTTP against the running stack, with a migrated and seeded
database. Accounts: a seeded `super_admin`, plus `teacher.a` / `teacher.b`
linked to two different `teachers` rows and `mentor.m` linked to a `mentors` row.

## Credentials login works end to end

Never verified before this session. `GET /api/auth/csrf` -> `POST
/api/auth/callback/credentials` -> session cookie set -> `GET /dashboard` = 200.

## The section gate was bypassable with a cookie I typed

Before the fix, signed in as a teacher with no gate unlocked:

```
no gate cookie      -> 307  /gate/observation?next=...
Cookie: gml-gate-observation=1   -> 200  (page rendered)
```

No password, no grant, no signature. That is the "section-level rotatable
passwords" hard requirement, defeated by one header.

Three separate layers were non-functional at once:
  1. `section_gates` was seeded by nothing -- the table was EMPTY on every
     deployment, so no section password existed to enter in the first place.
  2. The decision was an unsigned cookie compared to the string `"1"`.
  3. `section_gate_grants` was written on every unlock and read by nothing --
     `getActiveGrant()` had zero call sites.

## After the fix

Enforcement moved into server layouts for the gated segments
(`assertSectionGate` -> `getActiveGrant`). The proxy no longer gates at all: a
cookie "fast path" produces FALSE NEGATIVES (a user with a valid grant but no
cookie gets bounced before the layout runs), which this test caught.

| State | Result |
|---|---|
| Valid grant in DB, **no cookie at all** | **200 ACCESS** — correct, and the old cookie-only design would have wrongly denied it |
| After rotation deletes grants, no cookie | **307 DENIED** |
| After rotation, **forged cookie** | **307 DENIED** (was: 200 ACCESS) |

Rotation revokes for the first time.

## IDOR matrix

| Actor | Target | Result |
|---|---|---|
| teacher A | own observation cycle | 200 PASS |
| teacher A | **another teacher's cycle** | **404 PASS** |
| teacher A | a mentorship pairing | **404 PASS** |
| super_admin | another teacher's cycle | 200 PASS |
| super_admin | a mentorship pairing | 200 PASS |

404 rather than 403 is deliberate: a 403 on `/observation/<uuid>` confirms the
uuid names a real cycle, which is the enumeration signal being removed.

## Incidentally verified

- **The login rate limiter works.** Repeated attempts began returning
  `CredentialsSignin` with no session; Redis held
  `rl:login:127.0.0.1:teacher.a@test.invalid`. 5 attempts / 15 min per
  `ip:email`, as configured. It denied a *correct* password once the budget was
  spent, which is the intended fail-closed behaviour.
- **Migrations are idempotent across runs.** A second `migrate` applied only
  the new 0022 and logged
  `_post/001_revoke_audit_writes.sql already applied — skipping`.
- **SM-1 append-only triggers exist and are attached** (`audit_log_no_update`,
  `audit_log_no_delete`).

## Still open

- **There are no teacher or mentor accounts.** After a full seed the `users`
  table holds exactly ONE row, the `super_admin`; all 10 `teachers` and 2
  `mentors` rows have `user_id IS NULL`. The accounts above had to be created by
  hand for this test. Onboarding the people this product is for still has no
  mechanism -- and any invite flow must also LINK the new user to their
  `teachers` / `mentors` row, or the ownership checks resolve to nothing.
