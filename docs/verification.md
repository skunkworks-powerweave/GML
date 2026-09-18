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

---

# Worker image (B4) — resolved, verified by running it

`docker/worker.Dockerfile` produced an image with **no application source in
it**. Fixing that took four separate changes, and each one was only visible
because the container was actually started:

1. **No `COPY` of source at all.** The Dockerfile copied five `package.json`
   files, ran `pnpm install`, then `COPY --from=deps /repo /app` — so the image
   held `node_modules` and manifests and nothing else.
   `/app/apps/worker/src/index.ts` did not exist.
2. **`corepack enable` ran only in the deps stage**, so `pnpm` was not on `PATH`
   in the runner. The `CMD` could not have started even with source present.
3. **`pnpm exec` at runtime re-entered corepack**, which tried to download the
   pinned pnpm into `$HOME/.cache/node/corepack`. The container runs as the
   unprivileged `worker` user:
   `Error: EACCES: permission denied, mkdir '/home/worker/.cache/node/corepack/v1'`.
   The image still crash-looped — just on a different error. `CMD` now invokes
   the resolved bin directly, which also removes a network dependency from
   process start.
4. **`dotenv` was imported but never declared.** `apps/worker/src/index.ts`
   line 19 is `import "dotenv/config"`, and `dotenv` was not in
   `apps/worker/package.json` — it worked in the monorepo by hoisting and failed
   in a clean image with `ERR_MODULE_NOT_FOUND`. Now declared.

Booted against the real stack:

```
[worker][info] online {"redis":"redis://redis:6379","concurrency":1}
[worker][info] retention nightly schedule registered {"cron":"0 3 * * *"}
```

Connects to Redis and registers the SM-8 nightly retention job. First time this
container has ever run.

**Caveat:** the *real* image could not be built on this machine — local
antivirus blocks `apt-get` fetches for ffmpeg
(`499 Request has been forbidden by antivirus`). The verification above used an
otherwise-identical image with the ffmpeg layer removed, so the source layout,
module resolution, user permissions and startup path are all proven; the ffmpeg
binary itself is not. CI builds the real image on every push.

# CI — first run in the repository's history

The workflow had never executed once: it triggered on `push: branches: [main]`
while the branch was `master`, and there was no git remote at all. Both fixed.

The first run failed, on exactly the two things it was built to catch:

- **`container images` → `worker image has no entrypoint source`.** The job
  asserts the built worker image contains its entrypoint, and it caught B4 on
  its first execution. A Dockerfile can only be verified by building it.
- **`static` → `ENOENT: workspace/state.json`.** `test_001` asserted on
  `workspace/`, which `.gitignore` excludes (not even `workspace/.gitkeep` is
  tracked). The suite passed on a developer machine and failed on every clean
  checkout — precisely the failure mode predicted in the audit. Those two
  assertions now skip when the directory is absent, since per-machine agent
  scratch state is not a build input.

---

# Supabase project — setup and hardening

Project `zhoqmywalkiujmozcjws`, **ap-south-1 (Mumbai)**, Postgres 17.6, Pro plan.

## Region: caught before it cost anything

The project was first created in `ap-northeast-2` (**Seoul**). Measured from the
same host:

| Region | TCP latency to pooler |
|---|---|
| Seoul (`ap-northeast-2`) | **139 ms** |
| Mumbai (`ap-south-1`) | **16 ms** |

~9x, i.e. ~123 ms added to every database round trip. This app issues ~8 queries
per authenticated page render, ~15 on the dashboard and 20 concurrent on
`/admin/gates`, and the planned deployment target is AWS Mumbai — so every query
would have crossed Mumbai -> Seoul -> Mumbai for users in Ladakh.

Supabase cannot change a project's region after creation. The project was
recreated in Mumbai while it still had 0 tables. Confirmed after the move:

```
CONNECTED in 129 ms
round-trip latency: 9, 10, 11, 11, 11, 12 ms  (median 11ms)   [was ~135ms]
```

## Schema applied from scratch

```
public tables      : 47
drizzle migrations : 23
_post applied      : 1
SM-1 triggers      : audit_log_no_delete, audit_log_no_update
enums              : 10
foreign keys       : 64
```

First clean application of the full schema to a hosted database. Note this would
NOT have worked before this session: migration 0000 aborted on any empty database
with `42P07 relation "users_email_unique" already exists` (B15).

## Every table was readable by anyone on the internet

Immediately after the schema landed, using the **anon key — which is public by
design and ships in every browser bundle**:

```
GET /rest/v1/users?select=*      -> 200
GET /rest/v1/learners?select=*   -> 200
GET /rest/v1/audit_log?select=*  -> 200
GET /rest/v1/section_gates       -> 200
```

Tables were empty, so nothing leaked. With one teacher onboarded that is every
account email, the full staff roster, the entire audit trail, section-gate
password hashes, and — via `learners` — children's names, ages and guardian
details: the exact table SM-9 exists to protect.

Cause: PostgREST exposes the `public` schema, Supabase grants `anon` /
`authenticated` by default, and drizzle tables carry no RLS.

**Closed in two layers**, because either alone is one dashboard click from being
undone:

| Layer | Mechanism | Verified |
|---|---|---|
| SQL (`_post/002`) | REVOKE grants + schema USAGE, strip default privileges, enable RLS with no policies | `401 / 42501` on all tables |
| Gateway | `public` removed from exposed schemas | `404 / PGRST205 "Could not find the table 'graphql_public.users'"` |

Confirmed unaffected afterwards: the app still reads all 47 tables over the
direct connection (it never used PostgREST), and SM-1 still rejects UPDATE and
DELETE on `audit_log` — proven by a probe row that is now permanently in the
table because the trigger blocks its deletion.

`_post/001` also turned out to be a partial no-op on Supabase: it revokes from a
role named `gml`, which does not exist there, so SM-1's privilege layer rested
entirely on the triggers. `_post/002` names `anon` / `authenticated` /
`service_role` explicitly.

## Auth configuration

| Setting | State |
|---|---|
| JWT signing keys | **ES256 / EC** (verified at `/auth/v1/.well-known/jwks.json`) — tokens verify locally, no per-request call to Supabase |
| `disable_signup` | **true** — was `false`, i.e. public signup was open to the internet |
| Minimum password length | raised from 6 |
| Leaked-password protection | enabled |

## Still outstanding

- **Custom SMTP.** Supabase refuses to deliver mail to addresses outside the
  project team without it, so no teacher can be invited. Needs a verified sender
  domain, which has DNS lead time.
- **Storage buckets are anonymously listable** (`GET /storage/v1/bucket` -> `200 []`).
  Harmless with zero buckets; to be locked down via RLS on `storage.buckets` when
  the buckets are created.
